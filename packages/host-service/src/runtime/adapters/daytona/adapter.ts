import { randomUUID } from "node:crypto";
import { CodeLanguage } from "@daytonaio/sdk";
import { DAYTONA_DESCRIPTOR } from "../../descriptors/daytona.ts";
import {
	type CleanupMode,
	type NormalizedRuntimeStatus,
	type RuntimeAdapter,
	type RuntimeHandleFor,
	type RuntimePlan,
	RuntimeProviderError,
	type RuntimeRole,
} from "../../seam/index.ts";
import { buildShallowCloneCommand, CLONE_TOKEN_ENV } from "./cloneCommand.ts";
import {
	DaytonaWorkspaceRuntime,
	type RuntimeSandbox,
} from "./DaytonaWorkspaceRuntime.ts";
import { parseRepoCoordinates } from "./parse-repo.ts";
import { mapDaytonaState, toStoredStatus } from "./status-map.ts";
import { syncAgentAuthToSandbox } from "./syncAgentAuth.ts";
import type { DaytonaAdapterDeps, Sandbox } from "./types.ts";

const WORKDIR = "workspace";

/**
 * Prebuilt snapshot every remote workspace is created from. It already ships the
 * agent CLIs (Codex, Claude) so a sandbox is runnable as soon as the repo is
 * cloned and auth is synced. Bump this id to roll forward to a new snapshot.
 */
const DEFAULT_DAYTONA_SNAPSHOT =
	"terry-vCPU-4-RAM-8GB-2026-06-03-20-58-37-mdi1vf";

/**
 * Resolve the snapshot to provision from. `DAYTONA_SNAPSHOT` overrides the
 * default (set it to a valid snapshot id from your Daytona account); set it to
 * an empty string to provision a bare language image instead (no preinstalled
 * agent CLIs). Returns null to mean "no snapshot — use the base image".
 */
function resolveSnapshotId(): string | null {
	const override = process.env.DAYTONA_SNAPSHOT;
	if (override !== undefined) {
		const trimmed = override.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	return DEFAULT_DAYTONA_SNAPSHOT;
}

/** Caps clone/checkout failure output so an error message stays bounded. */
function truncateForError(output: string, max = 500): string {
	const trimmed = output.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Sandbox-relative directory the repo clones into: the repo NAME (so the
 * terminal opens in e.g. `~/bonaparte`, not `~/workspace`). Falls back to
 * {@link WORKDIR} when the url can't be parsed or yields an unusable name. The
 * chosen dir is persisted on the runtime instance (`metadataJson.workdir`) so
 * reconnect, the filesystem service, and the workspace router all resolve the
 * same dir for an existing sandbox.
 */
function resolveCloneDir(cloneUrl: string): string {
	try {
		const safe = parseRepoCoordinates(cloneUrl)
			.repo.replace(/[^A-Za-z0-9._-]/g, "-")
			.replace(/^[.-]+|-+$/g, "");
		return safe.length > 0 ? safe : WORKDIR;
	} catch {
		return WORKDIR;
	}
}

/**
 * First remote `RuntimeAdapter`. Maps the seam's provider-neutral lifecycle onto
 * the Daytona SDK:
 *   - createInstance: deny-all egress sandbox + scoped-token clone (Step 4/9).
 *   - reconnect: rebind a handle, starting a stopped sandbox first (Step 11).
 *   - getStatus: `sandbox.state` -> NormalizedRuntimeStatus (Step 8).
 *   - destroy: release lease + PTY, then `sdk.delete` (Step 4/9b).
 *
 * The SDK is dependency-injected (`deps.sdk`), so unit tests run against a fake
 * state machine and never hit the network.
 */
export class DaytonaRuntimeAdapter implements RuntimeAdapter {
	readonly descriptor = DAYTONA_DESCRIPTOR;

	private readonly now: () => number;
	private readonly syncAgentAuth: typeof syncAgentAuthToSandbox;

	constructor(private readonly deps: DaytonaAdapterDeps) {
		this.now = deps.now ?? Date.now;
		this.syncAgentAuth = deps.syncAgentAuth ?? syncAgentAuthToSandbox;
	}

	async createInstance<R extends RuntimeRole>(
		plan: RuntimePlan<R>,
	): Promise<RuntimeHandleFor<R>> {
		// v1 defaults to allow-all egress so the in-sandbox clone can reach GitHub
		// and the agent can reach package registries. Deny-all + CIDR allowlist is
		// a deferred opt-in (see egress.ts): Daytona egress is IPv4-CIDR-only and
		// tier-gated, so it cannot express a GitHub hostname allowlist, and locking
		// it down at create time breaks cloning.
		const snapshotId = resolveSnapshotId();
		const workdir = resolveCloneDir(plan.repo.cloneUrl);
		const sandbox = await this.deps.sdk.create(
			snapshotId
				? {
						// Provision from the prebuilt snapshot (agent CLIs already
						// installed) so remote agents are runnable once the repo clones.
						snapshot: snapshotId,
						envVars: plan.env ?? {},
						autoStopInterval: 15, // minutes; the in-memory lease keeps it alive
						ephemeral: false,
					}
				: {
						// No snapshot configured: a bare TS image (no agent CLIs).
						language: CodeLanguage.TYPESCRIPT, // never default to python
						envVars: plan.env ?? {},
						autoStopInterval: 15,
						ephemeral: false,
					},
		);

		// A failure after create() must not leak a paid sandbox. The post-create
		// setup (agent-auth sync + package-manager storage config) touches paths
		// disjoint from the clone (~/.codex, ~/.claude, pnpm config vs ~/workspace),
		// so it runs concurrently — its round-trips hide behind the clone. Each step
		// is best-effort (never rejects); the trailing `.catch` pins that at the call
		// site, so `await postSetup` on the teardown path can never reject or mask
		// the original clone error.
		let postSetup: Promise<void> = Promise.resolve();
		try {
			this.persistInstance(plan.workspaceId, sandbox, workdir);
			postSetup = Promise.all([
				this.syncAgentAuthBestEffort(sandbox),
				this.configureSandboxStorageBestEffort(sandbox),
			])
				.then(() => {})
				.catch(() => {});
			await this.cloneRepo(sandbox, plan, workdir);
		} catch (error) {
			await postSetup;
			await this.deleteAfterFailedProvision(sandbox);
			throw error;
		}
		await postSetup;

		return new DaytonaWorkspaceRuntime(
			sandbox as unknown as RuntimeSandbox,
			{ store: this.deps.store, now: this.now },
			workdir,
		) as unknown as RuntimeHandleFor<R>;
	}

	/**
	 * Uploads the host user's agent credentials into the sandbox, swallowing any
	 * failure. A missing/locked credential must never fail an otherwise-provisioned
	 * workspace, and neither the log line nor the result carries a secret.
	 */
	private async syncAgentAuthBestEffort(sandbox: Sandbox): Promise<void> {
		try {
			const result = await this.syncAgentAuth(
				sandbox as unknown as Parameters<typeof syncAgentAuthToSandbox>[0],
			);
			console.info(
				`[daytona] agent auth synced=${result.synced.length} skipped=${result.skipped.length}`,
			);
		} catch (error) {
			console.warn(
				"[daytona] agent auth sync failed (continuing):",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	/**
	 * Forces pnpm to HARDLINK its store into node_modules instead of copying.
	 * On the sandbox overlay fs pnpm defaults to copying, which keeps a full
	 * second copy of every dependency (store + node_modules) and overflows the
	 * capped sandbox disk on large monorepos. Hardlinking makes node_modules share
	 * the store's inodes, roughly halving install footprint so it fits the disk.
	 * Best-effort and pnpm-only: a non-pnpm repo simply never benefits, and a
	 * failure must not fail an otherwise-provisioned workspace.
	 */
	private async configureSandboxStorageBestEffort(
		sandbox: Sandbox,
	): Promise<void> {
		try {
			const res = await sandbox.process.executeCommand(
				"pnpm config set --location=global package-import-method hardlink",
			);
			if ((res.exitCode ?? 0) !== 0) {
				console.warn(
					"[daytona] pnpm hardlink config non-zero exit:",
					truncateForError(res.result ?? ""),
				);
			}
		} catch (error) {
			console.warn(
				"[daytona] sandbox storage config failed (continuing):",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	/** The clone dir recorded for a sandbox (repo name); WORKDIR for older rows. */
	private workdirFor(externalId: string): string {
		const wd = this.deps.store.get(externalId)?.metadataJson?.workdir;
		return typeof wd === "string" && wd.length > 0 ? wd : WORKDIR;
	}

	private async deleteAfterFailedProvision(sandbox: Sandbox): Promise<void> {
		try {
			await this.deps.sdk.delete(sandbox, 60);
		} catch {
			// Best-effort teardown; surface the original provisioning error instead.
		}
		this.deps.store.markDestroyed(sandbox.id, this.now());
	}

	private persistInstance(
		workspaceId: string,
		sandbox: Sandbox,
		workdir: string,
	): void {
		// metadataJson holds only NON-secret provider extras. The scoped token is
		// never written here (or anywhere persisted) — see cloneRepo. `workdir` is
		// the sandbox-relative clone dir (repo name); reconnect/fs/router read it.
		this.deps.store.insert({
			id: randomUUID(),
			workspaceId,
			provider: "daytona",
			role: "workspace",
			externalId: sandbox.id,
			status: toStoredStatus(mapDaytonaState(sandbox.state)),
			previewUrl: null,
			lastActivityAt: this.now(),
			metadataJson: { target: sandbox.target ?? null, workdir },
			createdAt: this.now(),
			destroyedAt: null,
			failureReason: null,
		});
	}

	/**
	 * Clones the repo SHALLOW (one commit, single branch, no tags) so a large
	 * monorepo neither overflows the sandbox disk nor pays the full-history
	 * transfer. The SDK's `git.clone` can only do a full clone, so this drops to a
	 * raw `git clone` via `executeCommand` to reach `--depth`/`--single-branch`.
	 *
	 * The short-lived single-repo-scoped token (`contents:write`/`metadata:read`,
	 * TTL <= 1h) is passed via the command's ENVIRONMENT, never argv: an inline
	 * credential helper reads `$CLONE_TOKEN_ENV` at clone time, so the token never
	 * appears in the command string, a command log, or metadataJson.
	 */
	private async cloneRepo(
		sandbox: Sandbox,
		plan: RuntimePlan<RuntimeRole>,
		workdir: string,
	): Promise<void> {
		const { owner, repo } = parseRepoCoordinates(plan.repo.cloneUrl);
		const { token } = await this.deps.mintRepoScopedToken({ owner, repo });
		// Clone the BASE ref (empty => the repo's default branch). The workspace
		// branch usually does not exist on the remote yet, so it is created in the
		// sandbox after the clone (createBranch) rather than cloned directly.
		const command = buildShallowCloneCommand({
			url: plan.repo.cloneUrl,
			workdir,
			baseRef: plan.repo.ref || undefined,
			// An empty token means no auth (e.g. a public repo): clone anonymously.
			// Sending "x-access-token" with an empty password makes GitHub reject the
			// clone ("Password authentication is not supported").
			authenticated: Boolean(token),
		});
		const cloneResult = await sandbox.process.executeCommand(
			command,
			undefined,
			token ? { [CLONE_TOKEN_ENV]: token } : undefined,
		);
		if ((cloneResult.exitCode ?? 0) !== 0) {
			throw new Error(
				`git clone failed (exit ${cloneResult.exitCode ?? 0}): ${truncateForError(
					cloneResult.result ?? "",
				)}`,
			);
		}
		if (plan.repo.createBranch) {
			const safeBranch = plan.repo.createBranch.replace(/'/g, "'\\''");
			const checkoutResult = await sandbox.process.executeCommand(
				`git checkout -b '${safeBranch}'`,
				workdir,
			);
			if ((checkoutResult.exitCode ?? 0) !== 0) {
				throw new Error(
					`git checkout -b failed (exit ${checkoutResult.exitCode ?? 0}): ${truncateForError(
						checkoutResult.result ?? "",
					)}`,
				);
			}
		}
	}

	async reconnect(externalId: string): Promise<RuntimeHandleFor<RuntimeRole>> {
		const sandbox = await this.deps.sdk.get(externalId);
		// A stopped sandbox keeps its disk but must be started before use.
		if (mapDaytonaState(sandbox.state).kind === "stopped") {
			await sandbox.start();
		}
		return new DaytonaWorkspaceRuntime(
			sandbox as unknown as RuntimeSandbox,
			{ store: this.deps.store, now: this.now },
			this.workdirFor(externalId),
		);
	}

	async getStatus(externalId: string): Promise<NormalizedRuntimeStatus> {
		try {
			const sandbox = await this.deps.sdk.get(externalId);
			return mapDaytonaState(sandbox.state);
		} catch {
			return { kind: "destroyed" };
		}
	}

	async destroy(externalId: string, _mode: CleanupMode): Promise<void> {
		const existing = this.deps.store.get(externalId);
		if (existing?.destroyedAt) return; // idempotent: already torn down
		let sandbox: Sandbox | null = null;
		try {
			sandbox = await this.deps.sdk.get(externalId);
		} catch {
			// Already gone provider-side; just record the local transition.
			this.deps.store.markDestroyed(externalId, this.now());
			return;
		}
		// Release host-side resources (lease + PTY) before deleting the sandbox.
		const handle = new DaytonaWorkspaceRuntime(
			sandbox as unknown as RuntimeSandbox,
			{ store: this.deps.store, now: this.now },
			this.workdirFor(externalId),
		);
		await handle.releaseResources();
		// delete() timeout is in SECONDS (SDK convention), not milliseconds.
		await this.deps.sdk.delete(sandbox, 60);
		this.deps.store.markDestroyed(externalId, this.now());
	}

	/** Throws if the configuration needed to talk to Daytona is absent. */
	static assertConfigured(
		apiKey: string | undefined,
	): asserts apiKey is string {
		if (!apiKey) {
			throw new RuntimeProviderError(
				"CONFIG_MISSING",
				"DAYTONA_API_KEY is not set; cannot create a Daytona runtime.",
			);
		}
	}
}
