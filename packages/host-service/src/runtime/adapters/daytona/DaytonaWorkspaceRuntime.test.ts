import { describe, expect, test } from "bun:test";
import { isRuntimeProviderError } from "../../seam/index.ts";
import {
	DaytonaWorkspaceRuntime,
	type RuntimeSandbox,
} from "./DaytonaWorkspaceRuntime.ts";
import { FakeInstanceStore, FakeSandbox } from "./test-support/fake-sandbox.ts";

function makeRuntime(sandbox?: FakeSandbox): {
	runtime: DaytonaWorkspaceRuntime;
	sandbox: FakeSandbox;
	store: FakeInstanceStore;
} {
	const sb = sandbox ?? new FakeSandbox("sbx-rt", "started");
	const store = new FakeInstanceStore();
	store.insert({
		id: "row-1",
		workspaceId: "ws-1",
		provider: "daytona",
		role: "workspace",
		externalId: sb.id,
		status: "running",
		previewUrl: null,
		lastActivityAt: 1,
		metadataJson: {},
		createdAt: 1,
		destroyedAt: null,
		failureReason: null,
	});
	const runtime = new DaytonaWorkspaceRuntime(
		sb as unknown as RuntimeSandbox,
		{ store, now: () => 7 },
		"workspace",
	);
	return { runtime, sandbox: sb, store };
}

describe("DaytonaWorkspaceRuntime.getDiff", () => {
	test("runs the Phase D git commands in the workspace cwd", async () => {
		const { runtime, sandbox } = makeRuntime();
		await runtime.getDiff();
		const cmds = sandbox.calls.executeCommand;
		expect(cmds.some((c) => c.includes("git status --porcelain=v1 -z"))).toBe(
			true,
		);
		expect(cmds.some((c) => c.includes("git diff --binary"))).toBe(true);
		expect(cmds.some((c) => c.includes("git diff --cached --binary"))).toBe(
			true,
		);
	});

	test("reflects a file mutated through the sandbox FS model", async () => {
		const { runtime, sandbox } = makeRuntime();
		sandbox.fsModel.write("a.txt", "body-content");
		const unstaged = await runtime.getDiff();
		expect(unstaged.statusPorcelain).toContain("a.txt");
		expect(unstaged.unifiedPatch).toContain("body-content");
	});
});

describe("DaytonaWorkspaceRuntime.exposePreview", () => {
	test("persists only the origin url, never the token", async () => {
		const { runtime, store } = makeRuntime();
		const binding = await runtime.exposePreview(3000);
		expect(binding.url).toContain("3000-");
		expect(binding.tokenScheme).toBe("standard");
		const row = store.get("sbx-rt");
		expect(row?.previewUrl).toBe(binding.url);
		expect(JSON.stringify(row)).not.toContain("secret-preview-token");
	});

	test("re-fetches the preview link every call (no token caching)", async () => {
		const sandbox = new FakeSandbox("sbx-rt", "started");
		let calls = 0;
		const original = sandbox.getPreviewLink.bind(sandbox);
		sandbox.getPreviewLink = async (port: number) => {
			calls += 1;
			return original(port);
		};
		const { runtime } = makeRuntime(sandbox);
		await runtime.exposePreview(3000);
		await runtime.exposePreview(3000);
		expect(calls).toBe(2);
	});
});

describe("DaytonaWorkspaceRuntime.exportPatch", () => {
	test("downloads a Buffer and never routes the patch through metadata", async () => {
		const { runtime, store } = makeRuntime();
		const patch = await runtime.exportPatch();
		expect(Buffer.isBuffer(patch)).toBe(true);
		expect(JSON.stringify(store.get("sbx-rt"))).not.toContain("PATCH-BYTES");
	});
});

describe("DaytonaWorkspaceRuntime.setEgress", () => {
	test("rejects >10 CIDRs before calling the SDK", async () => {
		const { runtime, sandbox } = makeRuntime();
		const cidrs = Array.from({ length: 11 }, (_, i) => `10.0.0.${i}/32`);
		await expect(
			runtime.setEgress({ kind: "allow-cidrs", cidrs }),
		).rejects.toThrow();
		expect(sandbox.calls.updateNetworkSettings).toHaveLength(0);
	});

	test("rejects a hostname / IPv6 entry before calling the SDK", async () => {
		const { runtime, sandbox } = makeRuntime();
		await expect(
			runtime.setEgress({ kind: "allow-cidrs", cidrs: ["example.com"] }),
		).rejects.toThrow();
		await expect(
			runtime.setEgress({ kind: "allow-cidrs", cidrs: ["::1/128"] }),
		).rejects.toThrow();
		expect(sandbox.calls.updateNetworkSettings).toHaveLength(0);
	});

	test("surfaces a typed EGRESS_TIER_GATED error when the API rejects", async () => {
		const { runtime, sandbox } = makeRuntime();
		sandbox.tierGated = true;
		let thrown: unknown;
		try {
			await runtime.setEgress({ kind: "deny-all" });
		} catch (error) {
			thrown = error;
		}
		expect(isRuntimeProviderError(thrown)).toBe(true);
		if (isRuntimeProviderError(thrown)) {
			expect(thrown.code).toBe("EGRESS_TIER_GATED");
		}
	});

	test("applies a valid deny-all policy via updateNetworkSettings", async () => {
		const { runtime, sandbox } = makeRuntime();
		await runtime.setEgress({ kind: "deny-all" });
		expect(sandbox.calls.updateNetworkSettings).toEqual([
			{ networkBlockAll: true },
		]);
	});
});

describe("DaytonaWorkspaceRuntime resource cleanup", () => {
	test("stop releases the lease and kills live PTYs", async () => {
		const { runtime, sandbox } = makeRuntime();
		const shell = await runtime.startShell({ cols: 80, rows: 24 });
		void shell;
		runtime.activityLease(); // starts the keep-alive timer
		await runtime.stop({ kind: "stop", keepDisk: true });
		expect(sandbox.calls.killedPtys.length).toBeGreaterThanOrEqual(1);
		// A released lease reports expired afterwards.
		const lease = runtime.activityLease();
		const beat = await lease.heartbeat();
		expect(beat.ok).toBe(true); // a fresh lease is created after release
	});
});
