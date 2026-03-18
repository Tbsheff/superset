import { beforeEach, describe, expect, mock, test } from "bun:test";

// Track sequential DB query results by index
let dbQueryResults: any[] = [];
let dbQueryIndex = 0;

mock.module("main/lib/local-db", () => ({
	localDb: {
		select: mock((..._args: any[]) => ({
			from: mock(() => ({
				where: mock(() => ({
					get: mock(() => dbQueryResults[dbQueryIndex++] ?? undefined),
				})),
			})),
		})),
	},
}));

mock.module("./local", () => ({
	LocalWorkspaceRuntime: class {
		id = "local";
		capabilities = { terminal: { persistent: true, coldRestore: true } };
	},
}));

mock.module("./ssh-workspace-runtime", () => ({
	SshWorkspaceRuntime: class {
		id: string;
		capabilities = { terminal: { persistent: false, coldRestore: false } };
		constructor(config: any) {
			this.id = `ssh:${config.id}`;
		}
	},
}));

const { getWorkspaceRuntimeRegistry, resetWorkspaceRuntimeRegistry } =
	await import("./registry");

beforeEach(() => {
	resetWorkspaceRuntimeRegistry();
	dbQueryIndex = 0;
	dbQueryResults = [];
});

describe("getDefault", () => {
	test("returns a LocalWorkspaceRuntime", () => {
		const registry = getWorkspaceRuntimeRegistry();
		const runtime = registry.getDefault();
		expect(runtime).toBeDefined();
		expect((runtime as any).id).toBe("local");
	});

	test("returns the same instance on subsequent calls (caching)", () => {
		const registry = getWorkspaceRuntimeRegistry();
		const first = registry.getDefault();
		const second = registry.getDefault();
		expect(first).toBe(second);
	});
});

describe("getForWorkspaceId", () => {
	test("returns local runtime when workspace has no remoteHostId", () => {
		dbQueryResults = [{ remoteHostId: null }];
		const registry = getWorkspaceRuntimeRegistry();
		const runtime = registry.getForWorkspaceId("ws-1");
		expect((runtime as any).id).toBe("local");
	});

	test("returns local runtime when workspace is not found", () => {
		dbQueryResults = [undefined];
		const registry = getWorkspaceRuntimeRegistry();
		const runtime = registry.getForWorkspaceId("ws-missing");
		expect((runtime as any).id).toBe("local");
	});

	test("returns SSH runtime when workspace has remoteHostId", () => {
		dbQueryResults = [
			{ remoteHostId: "host-1" },
			{
				id: "host-1",
				hostname: "example.com",
				username: "user",
				port: 22,
				authMethod: "agent",
			},
		];
		const registry = getWorkspaceRuntimeRegistry();
		const runtime = registry.getForWorkspaceId("ws-ssh");
		expect((runtime as any).id).toBe("ssh:host-1");
	});

	test("caches SSH runtime by hostId across multiple workspace lookups", () => {
		// First call: workspace lookup + host lookup
		dbQueryResults = [
			{ remoteHostId: "host-1" },
			{
				id: "host-1",
				hostname: "example.com",
				username: "user",
				port: 22,
				authMethod: "agent",
			},
		];
		const registry = getWorkspaceRuntimeRegistry();
		const first = registry.getForWorkspaceId("ws-a");

		// Second call: workspace lookup returns same host, no host lookup needed (cached)
		dbQueryResults = [{ remoteHostId: "host-1" }];
		dbQueryIndex = 0;
		const second = registry.getForWorkspaceId("ws-b");

		expect(first).toBe(second);
		expect((first as any).id).toBe("ssh:host-1");
	});

	test("falls back to local runtime when host config is incomplete (missing hostname)", () => {
		dbQueryResults = [
			{ remoteHostId: "host-bad" },
			{ id: "host-bad", hostname: null, username: null },
		];
		const registry = getWorkspaceRuntimeRegistry();
		const runtime = registry.getForWorkspaceId("ws-bad");
		expect((runtime as any).id).toBe("local");
	});

	test("falls back to local runtime when host record is not found", () => {
		dbQueryResults = [{ remoteHostId: "host-gone" }, undefined];
		const registry = getWorkspaceRuntimeRegistry();
		const runtime = registry.getForWorkspaceId("ws-orphan");
		expect((runtime as any).id).toBe("local");
	});
});

describe("getWorkspaceRuntimeRegistry", () => {
	test("returns the same registry instance on subsequent calls (singleton)", () => {
		const first = getWorkspaceRuntimeRegistry();
		const second = getWorkspaceRuntimeRegistry();
		expect(first).toBe(second);
	});

	test("returns a new instance after resetWorkspaceRuntimeRegistry", () => {
		const first = getWorkspaceRuntimeRegistry();
		resetWorkspaceRuntimeRegistry();
		const second = getWorkspaceRuntimeRegistry();
		expect(first).not.toBe(second);
	});
});
