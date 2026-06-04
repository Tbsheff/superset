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
import {
	DaytonaWorkspaceRuntime,
	type RuntimeSandbox,
} from "./DaytonaWorkspaceRuntime.ts";
import { parseRepoCoordinates } from "./parse-repo.ts";
import { mapDaytonaState, toStoredStatus } from "./status-map.ts";
import type { DaytonaAdapterDeps, Sandbox } from "./types.ts";

const WORKDIR = "workspace";

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

	constructor(private readonly deps: DaytonaAdapterDeps) {
		this.now = deps.now ?? Date.now;
	}

	async createInstance<R extends RuntimeRole>(
		plan: RuntimePlan<R>,
	): Promise<RuntimeHandleFor<R>> {
		// v1 defaults to allow-all egress so the in-sandbox clone can reach GitHub
		// and the agent can reach package registries. Deny-all + CIDR allowlist is
		// a deferred opt-in (see egress.ts): Daytona egress is IPv4-CIDR-only and
		// tier-gated, so it cannot express a GitHub hostname allowlist, and locking
		// it down at create time breaks cloning.
		const sandbox = await this.deps.sdk.create({
			language: CodeLanguage.TYPESCRIPT, // never default to python
			envVars: plan.env ?? {},
			autoStopInterval: 15, // minutes; the in-memory lease keeps it alive
			ephemeral: false,
		});

		// A failure after create() must not leak a paid sandbox.
		try {
			this.persistInstance(plan.workspaceId, sandbox);
			await this.cloneRepo(sandbox, plan);
		} catch (error) {
			await this.deleteAfterFailedProvision(sandbox);
			throw error;
		}

		return new DaytonaWorkspaceRuntime(
			sandbox as unknown as RuntimeSandbox,
			{ store: this.deps.store, now: this.now },
			WORKDIR,
		) as unknown as RuntimeHandleFor<R>;
	}

	private async deleteAfterFailedProvision(sandbox: Sandbox): Promise<void> {
		try {
			await this.deps.sdk.delete(sandbox, 60);
		} catch {
			// Best-effort teardown; surface the original provisioning error instead.
		}
		this.deps.store.markDestroyed(sandbox.id, this.now());
	}

	private persistInstance(workspaceId: string, sandbox: Sandbox): void {
		// metadataJson holds only NON-secret provider extras. The scoped token is
		// never written here (or anywhere persisted) — see cloneRepo.
		this.deps.store.insert({
			id: randomUUID(),
			workspaceId,
			provider: "daytona",
			role: "workspace",
			externalId: sandbox.id,
			status: toStoredStatus(mapDaytonaState(sandbox.state)),
			previewUrl: null,
			lastActivityAt: this.now(),
			metadataJson: { target: sandbox.target ?? null },
			createdAt: this.now(),
			destroyedAt: null,
			failureReason: null,
		});
	}

	/**
	 * Clones via a short-lived single-repo-scoped token passed straight to the
	 * Daytona host git API. The token rides ONE TLS call as the `password` arg
	 * with username `x-access-token`; it is `contents:write`/`metadata:read`
	 * scoped to ONE repo, TTL <= 1h, and is never persisted, logged, or written
	 * into metadataJson.
	 */
	private async cloneRepo(
		sandbox: Sandbox,
		plan: RuntimePlan<RuntimeRole>,
	): Promise<void> {
		const { owner, repo } = parseRepoCoordinates(plan.repo.cloneUrl);
		const { token } = await this.deps.mintRepoScopedToken({ owner, repo });
		// An empty token means no auth (e.g. a public repo): clone anonymously.
		// Sending "x-access-token" with an empty password makes GitHub reject the
		// clone ("Password authentication is not supported").
		if (!token) {
			await sandbox.git.clone(plan.repo.cloneUrl, WORKDIR, plan.repo.ref);
			return;
		}
		await sandbox.git.clone(
			plan.repo.cloneUrl,
			WORKDIR,
			plan.repo.ref,
			undefined,
			"x-access-token",
			token,
		);
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
			WORKDIR,
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
			WORKDIR,
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
