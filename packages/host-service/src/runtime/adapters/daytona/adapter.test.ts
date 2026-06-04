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
	test("creates an allow-all (no deny-all), typescript sandbox — never python", async () => {
		const { deps, sdk } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		await adapter.createInstance(plan);
		// v1 defaults to allow-all so the in-sandbox clone reaches GitHub.
		expect(sdk.lastCreate.networkBlockAll).toBeUndefined();
		expect(sdk.lastCreate.networkAllowList).toBeUndefined();
		expect(sdk.lastCreate.language).toBe("typescript");
		expect(sdk.lastCreate.language).not.toBe("python");
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

	test("clones with a single-repo-scoped token as x-access-token", async () => {
		const { deps, sdk, minted } = makeDeps();
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		expect(minted).toEqual([{ owner: "superset", repo: "demo" }]);
		const sandbox = sdk.sandboxes.get(handle.externalId);
		expect(sandbox?.calls.clone).toHaveLength(1);
		const clone = sandbox?.calls.clone[0];
		expect(clone?.username).toBe("x-access-token");
		expect(clone?.password).toBe("ghs_scoped_secret_token");
		expect(clone?.branch).toBe("main");
		expect(clone?.url).toBe(REPO_URL);
	});

	test("clones anonymously when no token is minted (public repo)", async () => {
		const { deps, sdk } = makeDeps({
			mintRepoScopedToken: async () => ({
				token: "",
				expiresAt: Date.now() + 3_600_000,
			}),
		});
		const adapter = new DaytonaRuntimeAdapter(deps);
		const handle = await adapter.createInstance(plan);
		const clone = sdk.sandboxes.get(handle.externalId)?.calls.clone[0];
		expect(clone?.username).toBeUndefined();
		expect(clone?.password).toBeUndefined();
		expect(clone?.url).toBe(REPO_URL);
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
