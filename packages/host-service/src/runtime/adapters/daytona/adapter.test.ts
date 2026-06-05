import { describe, expect, test } from "bun:test";
import type { GitFactory } from "../../git/types.ts";
import { isRuntimeProviderError } from "../../seam/index.ts";
import { DaytonaRuntimeAdapter } from "./adapter.ts";
import {
	FakeDaytonaSdk,
	FakeInstanceStore,
} from "./test-support/fake-sandbox.ts";
import type { DaytonaAdapterDeps, TokenMinter } from "./types.ts";

const REPO_URL = "https://github.com/superset/demo.git";

function makeDeps(overrides?: Partial<DaytonaAdapterDeps>): {
	deps: DaytonaAdapterDeps;
	sdk: FakeDaytonaSdk;
	store: FakeInstanceStore;
	minted: Array<{ owner: string; repo: string }>;
} {
	const sdk = new FakeDaytonaSdk();
	const store = new FakeInstanceStore();
	const minted: Array<{ owner: string; repo: string }> = [];
	const mintRepoScopedToken: TokenMinter = async ({ owner, repo }) => {
		minted.push({ owner, repo });
		return {
			token: "ghs_scoped_secret_token",
			expiresAt: Date.now() + 3_600_000,
		};
	};
	const git: GitFactory = (async () => {
		throw new Error("git factory must not be called by the adapter unit tests");
	}) as unknown as GitFactory;
	const deps: DaytonaAdapterDeps = {
		sdk,
		store,
		git,
		mintRepoScopedToken,
		now: () => 1_000,
		// No-op so the unit tests never read the host keychain / ~/.codex.
		syncAgentAuth: async () => ({ synced: [], skipped: [] }),
		...overrides,
	};
	return { deps, sdk, store, minted };
}

const plan = {
	role: "workspace" as const,
	workspaceId: "ws-1",
	repo: { cloneUrl: REPO_URL, ref: "main" },
};

describe("DaytonaRuntimeAdapter.createInstance", () => {
	test("creates an allow-all (no deny-all) sandbox from the configured snapshot", async () => {
		const { deps, sdk } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		await adapter.createInstance(plan);
		// v1 defaults to allow-all so the in-sandbox clone reaches GitHub.
		expect(sdk.lastCreate.networkBlockAll).toBeUndefined();
		expect(sdk.lastCreate.networkAllowList).toBeUndefined();
		// Provisions from the prebuilt snapshot (agent CLIs preinstalled); the
		// snapshot defines the image, so no bare `language` is sent.
		expect(sdk.lastCreate.snapshot).toBeTruthy();
		expect(sdk.lastCreate.language).toBeUndefined();
	});

	test("inserts a runtime_instances row mapped from the sandbox state", async () => {
		const { deps, store } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		const row = store.get(handle.externalId);
		expect(row).toBeDefined();
		expect(row?.provider).toBe("daytona");
		expect(row?.role).toBe("workspace");
		expect(row?.externalId).toBe(handle.externalId);
		expect(row?.status).toBe("running"); // started -> running
	});

	test("clones SHALLOW with the scoped token passed via env, never argv", async () => {
		const { deps, sdk, minted } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		expect(minted).toEqual([{ owner: "superset", repo: "demo" }]);
		const sandbox = sdk.sandboxes.get(handle.externalId);
		const clone = sandbox?.calls.exec.find((c) =>
			c.command.includes("--depth=1"),
		);
		expect(clone).toBeDefined();
		expect(clone?.command).toContain("--single-branch");
		expect(clone?.command).toContain("--branch 'main'");
		expect(clone?.command).toContain(REPO_URL);
		// The token rides the ENV, not the command string.
		expect(clone?.env?.SUPERSET_CLONE_TOKEN).toBe("ghs_scoped_secret_token");
		expect(clone?.command).not.toContain("ghs_scoped_secret_token");
	});

	test("clones anonymously (no credential helper, no env) for a public repo", async () => {
		const { deps, sdk } = makeDeps({
			mintRepoScopedToken: async () => ({
				token: "",
				expiresAt: Date.now() + 3_600_000,
			}),
		});
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		const clone = sdk.sandboxes
			.get(handle.externalId)
			?.calls.exec.find((c) => c.command.includes("--depth=1"));
		expect(clone).toBeDefined();
		expect(clone?.command.startsWith("git clone")).toBe(true);
		expect(clone?.command).not.toContain("credential.helper");
		expect(clone?.env).toBeUndefined();
		expect(clone?.command).toContain(REPO_URL);
	});

	test("creates the workspace branch after the shallow clone", async () => {
		const { deps, sdk } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance({
			...plan,
			repo: { ...plan.repo, createBranch: "feature/x" },
		});
		const commands =
			sdk.sandboxes.get(handle.externalId)?.calls.executeCommand ?? [];
		expect(commands).toContain("git checkout -b 'feature/x'");
	});

	test("fails (and tears down) when the shallow clone exits non-zero", async () => {
		const { deps, sdk } = makeDeps();
		sdk.cloneExitCode = 128; // every sandbox this sdk creates fails its clone
		const adapter = new DaytonaRuntimeAdapter(deps);
		await expect(adapter.createInstance(plan)).rejects.toThrow(
			"git clone failed",
		);
		const created = [...sdk.sandboxes.values()];
		expect(created[0]?.calls.deleted).toBe(1);
	});

	test("a clone failure surfaces the clone error even if auth sync rejects mid-flight", async () => {
		// Auth runs concurrently with the clone; a rejecting auth sync must never
		// mask the clone error nor cause a double teardown.
		const { deps, sdk } = makeDeps({
			syncAgentAuth: async () => {
				await Promise.resolve();
				throw new Error("auth boom");
			},
		});
		sdk.cloneExitCode = 128;
		const adapter = new DaytonaRuntimeAdapter(deps);
		await expect(adapter.createInstance(plan)).rejects.toThrow(
			"git clone failed",
		);
		const created = [...sdk.sandboxes.values()];
		expect(created[0]?.calls.deleted).toBe(1);
	});

	test("never leaks the scoped token into any executed command string", async () => {
		const { deps, sdk } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		const commands =
			sdk.sandboxes.get(handle.externalId)?.calls.executeCommand ?? [];
		for (const command of commands) {
			expect(command).not.toContain("ghs_scoped_secret_token");
		}
	});

	test("configures pnpm hardlink storage so a big install fits the capped disk", async () => {
		const { deps, sdk } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		const commands =
			sdk.sandboxes.get(handle.externalId)?.calls.executeCommand ?? [];
		expect(
			commands.some((c) => c.includes("package-import-method hardlink")),
		).toBe(true);
	});

	test("clones into the repo-name dir (not 'workspace') and records it", async () => {
		const { deps, sdk, store } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance({
			...plan,
			repo: { ...plan.repo, createBranch: "feature/x" },
		});
		const exec = sdk.sandboxes.get(handle.externalId)?.calls.exec ?? [];
		const clone = exec.find((c) => c.command.includes("--depth=1"));
		expect(clone?.command).toContain("'demo'"); // repo name, from .../superset/demo.git
		expect(clone?.command).not.toContain("'workspace'");
		const checkout = exec.find((c) => c.command.includes("git checkout -b"));
		expect(checkout?.cwd).toBe("demo");
		// persisted so reconnect/fs/router resolve the same dir
		expect(store.get(handle.externalId)?.metadataJson?.workdir).toBe("demo");
	});

	test("reconnect runs git in the recorded repo-name workdir", async () => {
		const { deps, sdk } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		const resumed = await adapter.reconnect(handle.externalId);
		await resumed.getDiff();
		const status = sdk.sandboxes
			.get(handle.externalId)
			?.calls.exec.find((c) => c.command.includes("git status --porcelain"));
		expect(status?.cwd).toBe("demo");
	});

	test("never persists the scoped token into metadataJson", async () => {
		const { deps, store } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		const row = store.get(handle.externalId);
		const serialized = JSON.stringify(row?.metadataJson ?? {});
		expect(serialized).not.toContain("ghs_scoped_secret_token");
	});

	test("rejects a clone url with no owner/repo before minting a token", async () => {
		const { deps, minted } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		let thrown: unknown;
		try {
			await adapter.createInstance({
				role: "workspace",
				workspaceId: "ws-bad",
				repo: { cloneUrl: "https://example.test/nope", ref: "main" },
			});
		} catch (error) {
			thrown = error;
		}
		expect(isRuntimeProviderError(thrown)).toBe(true);
		expect(minted).toHaveLength(0);
	});

	test("deletes the sandbox if provisioning fails after create (no leak)", async () => {
		const { deps, sdk } = makeDeps({
			mintRepoScopedToken: async () => {
				throw new Error("mint failed");
			},
		});
		const adapter = new DaytonaRuntimeAdapter(deps);
		await expect(adapter.createInstance(plan)).rejects.toThrow("mint failed");
		const created = [...sdk.sandboxes.values()];
		expect(created).toHaveLength(1);
		expect(created[0]?.calls.deleted).toBe(1);
		expect(created[0]?.state).toBe("destroyed");
	});
});

describe("DaytonaRuntimeAdapter.destroy", () => {
	test("deletes the sandbox with a SECONDS timeout and records destroyedAt", async () => {
		const { deps, sdk, store } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		await adapter.destroy(handle.externalId, { kind: "delete" });
		const sandbox = sdk.sandboxes.get(handle.externalId);
		expect(sandbox?.calls.deleted).toBe(1);
		expect(store.get(handle.externalId)?.destroyedAt).toBe(1_000);
		expect(store.get(handle.externalId)?.status).toBe("stopped");
	});

	test("is idempotent — a second destroy does not re-delete", async () => {
		const { deps, sdk } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		await adapter.destroy(handle.externalId, { kind: "delete" });
		await adapter.destroy(handle.externalId, { kind: "delete" });
		const sandbox = sdk.sandboxes.get(handle.externalId);
		expect(sandbox?.calls.deleted).toBe(1);
	});
});

describe("DaytonaRuntimeAdapter.reconnect / getStatus / config", () => {
	test("reconnect starts a stopped sandbox before returning", async () => {
		const { deps, sdk } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		const sandbox = sdk.sandboxes.get(handle.externalId);
		if (sandbox) sandbox.state = "stopped";
		await adapter.reconnect(handle.externalId);
		expect(sandbox?.calls.started).toBe(1);
	});

	test("reconnect does not start an already-running sandbox", async () => {
		const { deps, sdk } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		await adapter.reconnect(handle.externalId);
		const sandbox = sdk.sandboxes.get(handle.externalId);
		expect(sandbox?.calls.started).toBe(0);
	});

	test("reconnect resumes a STOPPED sandbox with the fast (120s) timeout", async () => {
		const { deps, sdk } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		const sandbox = sdk.sandboxes.get(handle.externalId);
		if (sandbox) sandbox.state = "stopped";
		await adapter.reconnect(handle.externalId);
		expect(sandbox?.calls.startTimeouts).toEqual([120]);
	});

	test("reconnect resumes an ARCHIVED sandbox with the slow (300s) timeout", async () => {
		const { deps, sdk } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		const sandbox = sdk.sandboxes.get(handle.externalId);
		if (sandbox) sandbox.state = "archived";
		await adapter.reconnect(handle.externalId);
		expect(sandbox?.calls.startTimeouts).toEqual([300]);
	});

	test("reconnect retries start ONCE on a transient failure", async () => {
		const { deps, sdk } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		const sandbox = sdk.sandboxes.get(handle.externalId);
		if (sandbox) {
			sandbox.state = "stopped";
			sandbox.startFailuresRemaining = 1; // first start throws, retry succeeds
		}
		await adapter.reconnect(handle.externalId);
		expect(sandbox?.calls.startTimeouts).toHaveLength(2); // one fail + one retry
		expect(sandbox?.calls.started).toBe(1); // only the retry succeeded
	});

	test("reconnect treats a race-to-running as success (no redundant start)", async () => {
		const { deps, sdk } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		const sandbox = sdk.sandboxes.get(handle.externalId);
		if (sandbox) {
			sandbox.state = "stopped";
			sandbox.startFailuresRemaining = 1;
			sandbox.setRunningOnFailedStart = true; // another caller resumed it
		}
		await adapter.reconnect(handle.externalId);
		// First start threw but left it running; the retry path sees running and
		// does NOT call start again, so no start ever "succeeds" via our path.
		expect(sandbox?.calls.startTimeouts).toHaveLength(1);
		expect(sandbox?.calls.started).toBe(0);
	});

	test("reconnect rethrows when both start attempts fail", async () => {
		const { deps, sdk } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		const sandbox = sdk.sandboxes.get(handle.externalId);
		if (sandbox) {
			sandbox.state = "stopped";
			sandbox.startFailuresRemaining = 2; // both attempts throw
		}
		await expect(adapter.reconnect(handle.externalId)).rejects.toThrow(
			/simulated start failure/,
		);
	});

	test("getStatus maps the live sandbox state", async () => {
		const { deps, sdk } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		const sandbox = sdk.sandboxes.get(handle.externalId);
		if (sandbox) sandbox.state = "error";
		const status = await adapter.getStatus(handle.externalId);
		expect(status.kind).toBe("failed");
	});

	test("assertConfigured throws CONFIG_MISSING with no key", () => {
		let thrown: unknown;
		try {
			DaytonaRuntimeAdapter.assertConfigured(undefined);
		} catch (error) {
			thrown = error;
		}
		expect(isRuntimeProviderError(thrown)).toBe(true);
		if (isRuntimeProviderError(thrown)) {
			expect(thrown.code).toBe("CONFIG_MISSING");
		}
	});
});
