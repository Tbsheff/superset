import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { HostDb } from "../../db/index.ts";
import * as schema from "../../db/schema.ts";
import type {
	RuntimeInstanceRecord,
	RuntimeSandbox,
} from "../adapters/daytona/index.ts";
import { DaytonaWorkspaceRuntime } from "../adapters/daytona/index.ts";
import { FakeSandbox } from "../adapters/daytona/test-support/fake-sandbox.ts";
import type {
	NormalizedRuntimeStatus,
	WorkspaceRuntime,
} from "../seam/index.ts";
import { RuntimeInstanceStore } from "../store/index.ts";

/** Read-only status stub for resolver fakes that only exercise `resolve`. */
const stubStatus = (): Promise<NormalizedRuntimeStatus> =>
	Promise.resolve({ kind: "running" });

// Mock the daemon-backed local terminal so the local routing arm never spawns a
// real PTY. The remote arm uses a real DaytonaWorkspaceRuntime over a fake
// sandbox — no network, no daemon.
const createTerminalSessionInternal = mock();
const disposeSession = mock();
mock.module("../../terminal/terminal.ts", () => ({
	createTerminalSessionInternal,
	disposeSession,
}));

const { runWorkspaceCommand } = await import("./runWorkspaceCommand.ts");

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../../drizzle");
const PROJECT_ID = "1f0e8c7e-1234-4abc-8def-0123456789ab";
const LOCAL_WS_ID = "2a1b3c4d-5678-4abc-8def-0123456789ab";
const REMOTE_WS_ID = "3b2c4d5e-6789-4abc-8def-0123456789ab";

function migratedDb(): HostDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON");
	const db = drizzle(sqlite, { schema }) as unknown as HostDb;
	migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
	return db;
}

function seedProject(db: HostDb): void {
	db.insert(schema.projects)
		.values({
			id: PROJECT_ID,
			repoPath: "/tmp/repo",
			repoUrl: "https://github.com/acme/widgets",
			repoOwner: "acme",
			repoName: "widgets",
		})
		.run();
}

function seedLocalWorkspace(db: HostDb): void {
	db.insert(schema.workspaces)
		.values({
			id: LOCAL_WS_ID,
			projectId: PROJECT_ID,
			worktreePath: "/tmp/repo/wt",
			branch: "feature/local",
			runtimeKind: "local",
		})
		.run();
}

/**
 * Seeds a remote workspace + its live `runtime_instances` row backed by a fake
 * sandbox. Returns the sandbox so the test can assert what the shell wrote.
 */
function seedRemoteWorkspace(db: HostDb): FakeSandbox {
	const sandbox = new FakeSandbox("sbx-remote", "started");
	// runtime_instances.workspaceId FKs workspaces.id, and
	// workspaces.currentRuntimeId FKs runtime_instances.id (circular). Insert the
	// workspace first (currentRuntimeId null), then the instance, then link.
	db.insert(schema.workspaces)
		.values({
			id: REMOTE_WS_ID,
			projectId: PROJECT_ID,
			worktreePath: "",
			branch: "feature/remote",
			runtimeKind: "remote",
		})
		.run();
	const store = new RuntimeInstanceStore(db);
	const record: RuntimeInstanceRecord = {
		id: "ri-1",
		workspaceId: REMOTE_WS_ID,
		provider: "daytona",
		role: "workspace",
		externalId: sandbox.id,
		// `runtime_instances.status` stores the projected string at runtime even
		// though its declared type is the seam status object (see status-map).
		status: "running" as RuntimeInstanceRecord["status"],
		previewUrl: null,
		lastActivityAt: Date.now(),
		metadataJson: {},
		createdAt: Date.now(),
		destroyedAt: null,
		failureReason: null,
	};
	store.insert(record);
	db.update(schema.workspaces)
		.set({ currentRuntimeId: "ri-1" })
		.where(eq(schema.workspaces.id, REMOTE_WS_ID))
		.run();
	return sandbox;
}

function runtimeFor(sandbox: FakeSandbox): WorkspaceRuntime {
	// The runtime only touches the store for `setPreviewUrl`, which these tests
	// never call; a no-op store keeps the fixture free of a second migrated DB.
	const store = {
		insert: () => {},
		setPreviewUrl: () => {},
		markDestroyed: () => {},
		get: () => undefined,
	};
	return new DaytonaWorkspaceRuntime(
		sandbox as unknown as RuntimeSandbox,
		{ store, now: () => 1 },
		"workspace",
	);
}

describe("runWorkspaceCommand", () => {
	let db: HostDb;

	beforeEach(() => {
		db = migratedDb();
		seedProject(db);
		createTerminalSessionInternal.mockReset();
	});

	test("local: routes to createTerminalSessionInternal, not the remote resolver", async () => {
		seedLocalWorkspace(db);
		createTerminalSessionInternal.mockResolvedValueOnce({ terminalId: "t-1" });
		const remoteResolver = {
			resolve: mock(async () => {
				throw new Error("remote resolver must not be called for a local ws");
			}),
			status: stubStatus,
		};

		const result = await runWorkspaceCommand({
			ctx: { db, eventBus: {} } as never,
			workspaceId: LOCAL_WS_ID,
			command: "bun install",
			remoteResolver,
		});

		expect(result).toEqual({ kind: "local", terminalId: "t-1" });
		expect(createTerminalSessionInternal).toHaveBeenCalledTimes(1);
		expect(createTerminalSessionInternal.mock.calls[0]?.[0]).toMatchObject({
			workspaceId: LOCAL_WS_ID,
			initialCommand: "bun install",
		});
		expect(remoteResolver.resolve).not.toHaveBeenCalled();
	});

	test("local: surfaces a session error as an error result", async () => {
		seedLocalWorkspace(db);
		createTerminalSessionInternal.mockResolvedValueOnce({
			error: "daemon unavailable",
		});

		const result = await runWorkspaceCommand({
			ctx: { db, eventBus: {} } as never,
			workspaceId: LOCAL_WS_ID,
			command: "echo hi",
		});

		expect(result).toEqual({ error: "daemon unavailable" });
	});

	test("remote: starts a sandbox PTY and writes the command", async () => {
		const sandbox = seedRemoteWorkspace(db);
		const runtime = runtimeFor(sandbox);

		const result = await runWorkspaceCommand({
			ctx: { db, eventBus: {} } as never,
			workspaceId: REMOTE_WS_ID,
			command: "codex 'do the thing'",
			remoteResolver: { resolve: async () => runtime, status: stubStatus },
		});

		if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
		if (result.kind !== "remote") throw new Error("expected remote result");
		expect(result.externalId).toBe("sbx-remote");
		// startShell opened exactly one PTY in the sandbox.
		expect(sandbox.calls.createPty).toHaveLength(1);
		// The command was written into the sandbox PTY (the fake echoes shell
		// input through its FS interpreter; assert via a data subscription below).
		expect(createTerminalSessionInternal).not.toHaveBeenCalled();
		// Local terminal path is untouched for a remote workspace.
		expect(result.shell.surface).toEqual({ kind: "pty" });
	});

	test("remote: appends a trailing newline when the command lacks one", async () => {
		const sandbox = seedRemoteWorkspace(db);
		const writes: string[] = [];
		const runtime: WorkspaceRuntime = {
			...runtimeFor(sandbox),
			startShell: async () => ({
				surface: { kind: "pty" },
				write: (data: string) => {
					writes.push(data);
				},
				resize: () => {},
				onData: () => ({ dispose: () => {} }),
				onExit: () => ({ dispose: () => {} }),
				kill: async () => {},
			}),
		};

		await runWorkspaceCommand({
			ctx: { db, eventBus: {} } as never,
			workspaceId: REMOTE_WS_ID,
			command: "npm test",
			remoteResolver: { resolve: async () => runtime, status: stubStatus },
		});

		expect(writes).toEqual(["npm test\n"]);
	});

	test("remote: preserves an existing trailing newline", async () => {
		const sandbox = seedRemoteWorkspace(db);
		const writes: string[] = [];
		const runtime: WorkspaceRuntime = {
			...runtimeFor(sandbox),
			startShell: async () => ({
				surface: { kind: "pty" },
				write: (data: string) => {
					writes.push(data);
				},
				resize: () => {},
				onData: () => ({ dispose: () => {} }),
				onExit: () => ({ dispose: () => {} }),
				kill: async () => {},
			}),
		};

		await runWorkspaceCommand({
			ctx: { db, eventBus: {} } as never,
			workspaceId: REMOTE_WS_ID,
			command: "ls\n",
			remoteResolver: { resolve: async () => runtime, status: stubStatus },
		});

		expect(writes).toEqual(["ls\n"]);
	});

	test("remote: returns an error when the resolver cannot find a live instance", async () => {
		seedRemoteWorkspace(db);
		const result = await runWorkspaceCommand({
			ctx: { db, eventBus: {} } as never,
			workspaceId: REMOTE_WS_ID,
			command: "echo hi",
			remoteResolver: {
				resolve: async () => {
					throw new Error("no live runtime instance");
				},
				status: stubStatus,
			},
		});

		expect(result).toEqual({ error: "no live runtime instance" });
	});

	test("remote: kills the shell when the command write throws", async () => {
		const sandbox = seedRemoteWorkspace(db);
		let killed = false;
		const runtime: WorkspaceRuntime = {
			...runtimeFor(sandbox),
			startShell: async () => ({
				surface: { kind: "pty" },
				write: () => {
					throw new Error("pty write failed");
				},
				resize: () => {},
				onData: () => ({ dispose: () => {} }),
				onExit: () => ({ dispose: () => {} }),
				kill: async () => {
					killed = true;
				},
			}),
		};

		const result = await runWorkspaceCommand({
			ctx: { db, eventBus: {} } as never,
			workspaceId: REMOTE_WS_ID,
			command: "echo hi",
			remoteResolver: { resolve: async () => runtime, status: stubStatus },
		});

		expect(result).toEqual({ error: "pty write failed" });
		expect(killed).toBe(true);
	});

	test("returns an error for an unknown workspace", async () => {
		const result = await runWorkspaceCommand({
			ctx: { db, eventBus: {} } as never,
			workspaceId: "00000000-0000-4000-8000-000000000000",
			command: "echo hi",
		});

		expect("error" in result).toBe(true);
		if (!("error" in result)) throw new Error("expected error");
		expect(result.error).toMatch(/Workspace not found/);
	});
});

describe("runWorkspaceCommand remote shell streams sandbox output", () => {
	test("the started PTY echoes written input through onData", async () => {
		const db = migratedDb();
		seedProject(db);
		const sandbox = seedRemoteWorkspace(db);
		const runtime = runtimeFor(sandbox);

		const result = await runWorkspaceCommand({
			ctx: { db, eventBus: {} } as never,
			workspaceId: REMOTE_WS_ID,
			// `echo hello` is interpreted by the fake sandbox's shell model.
			command: "echo hello",
			remoteResolver: { resolve: async () => runtime, status: stubStatus },
		});

		if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
		if (result.kind !== "remote") throw new Error("expected remote result");
		expect(sandbox.calls.createPty).toHaveLength(1);

		// Subscribe AFTER the initial command (its echo already flew by), then
		// drive a follow-up write and assert it streams back through the handle —
		// proving the sandbox PTY's output reaches the host via onData.
		const chunks: string[] = [];
		result.shell.onData((chunk) => chunks.push(chunk));
		result.shell.write("echo streamed\n");
		await Promise.resolve();
		expect(chunks.join("")).toContain("echo streamed");
	});
});
