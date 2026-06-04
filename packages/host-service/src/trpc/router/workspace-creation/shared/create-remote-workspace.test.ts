import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { HostDb } from "../../../../db/index";
import * as schema from "../../../../db/schema";
import { FakeDaytonaSdk } from "../../../../runtime/adapters/daytona/test-support/fake-sandbox";
import type { TokenMinter } from "../../../../runtime/adapters/daytona/types";
import {
	getRuntimeAdapter,
	type RuntimeAdapterDeps,
} from "../../../../runtime/registry/index";
import { RuntimeInstanceStore } from "../../../../runtime/store/index";
import type { HostServiceContext } from "../../../../types";
import {
	createRemoteWorkspace,
	type RemoteRuntime,
} from "./create-remote-workspace";
import type { LocalProject } from "./local-project";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../../../../drizzle");
const PROJECT_ID = "1f0e8c7e-1234-4abc-8def-0123456789ab";
const WORKSPACE_ID = "2a1b3c4d-5678-4abc-8def-0123456789ab";
const REPO_URL = "https://github.com/acme/widgets";

function migratedDb(): HostDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON");
	const db = drizzle(sqlite, { schema }) as unknown as HostDb;
	migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
	return db;
}

function seedProject(db: HostDb, repoUrl: string | null): LocalProject {
	db.insert(schema.projects)
		.values({
			id: PROJECT_ID,
			repoPath: "/tmp/repo",
			repoUrl,
			repoOwner: "acme",
			repoName: "widgets",
		})
		.run();
	return db.query.projects
		.findFirst({ where: eq(schema.projects.id, PROJECT_ID) })
		.sync() as LocalProject;
}

const mintRepoScopedToken: TokenMinter = async ({ owner, repo }) => ({
	token: `ghs_${owner}_${repo}`,
	expiresAt: Date.now() + 3_600_000,
});

interface CloudCalls {
	create: unknown[];
	delete: unknown[];
}

function makeCtx(db: HostDb, calls: CloudCalls): { ctx: HostServiceContext } {
	const api = {
		v2Workspace: {
			create: {
				mutate: async (args: { id?: string; name: string; branch: string }) => {
					calls.create.push(args);
					return {
						id: args.id ?? WORKSPACE_ID,
						name: args.name,
						branch: args.branch,
						organizationId: "org-1",
						projectId: PROJECT_ID,
						hostId: "host-1",
						type: "worktree",
						txid: 42,
					};
				},
			},
			delete: {
				mutate: async (args: { id: string }) => {
					calls.delete.push(args);
					return { success: true };
				},
			},
		},
	};
	const ctx = {
		db,
		git: (async () => ({}) as never) as HostServiceContext["git"],
		api: api as unknown as HostServiceContext["api"],
		organizationId: "org-1",
		mintRepoScopedToken,
	} as unknown as HostServiceContext;
	return { ctx };
}

/** Real remote runtime: the production registry adapter over fake SDK/store. */
function makeRemoteRuntime(db: HostDb): RemoteRuntime {
	const store = new RuntimeInstanceStore(db);
	const deps: RuntimeAdapterDeps = {
		db,
		git: (async () => ({}) as never) as RuntimeAdapterDeps["git"],
		sdk: new FakeDaytonaSdk() as never,
		store,
		mintRepoScopedToken,
	};
	return {
		store,
		getAdapter: () => getRuntimeAdapter("remote", deps),
	};
}

describe("createRemoteWorkspace", () => {
	let db: HostDb;
	let calls: CloudCalls;

	beforeEach(() => {
		db = migratedDb();
		calls = { create: [], delete: [] };
	});

	test("routes to the remote adapter and marks the workspace remote", async () => {
		const localProject = seedProject(db, REPO_URL);
		const { ctx } = makeCtx(db, calls);
		const runtime = makeRemoteRuntime(db);

		const result = await createRemoteWorkspace({
			ctx,
			localProject,
			id: WORKSPACE_ID,
			name: "Remote WS",
			branch: "feature/remote",
			taskId: undefined,
			hostPromise: Promise.resolve({ machineId: "host-1" }),
			runtime,
		});

		expect(result.workspace.id).toBe(WORKSPACE_ID);
		expect(result.externalId).toBe("sbx-1");
		expect(result.runtimeInstanceId).toBeTruthy();

		const row = db.query.workspaces
			.findFirst({ where: eq(schema.workspaces.id, WORKSPACE_ID) })
			.sync();
		expect(row?.runtimeKind).toBe("remote");
		expect(row?.worktreePath).toBe("");
		expect(row?.currentRuntimeId).toBe(result.runtimeInstanceId);
	});

	test("persists a daytona runtime_instances row keyed to the workspace", async () => {
		const localProject = seedProject(db, REPO_URL);
		const { ctx } = makeCtx(db, calls);
		const runtime = makeRemoteRuntime(db);

		const result = await createRemoteWorkspace({
			ctx,
			localProject,
			id: WORKSPACE_ID,
			name: "Remote WS",
			branch: "feature/remote",
			taskId: undefined,
			hostPromise: Promise.resolve({ machineId: "host-1" }),
			runtime,
		});

		const instance = db.query.runtimeInstances
			.findFirst({
				where: eq(schema.runtimeInstances.id, result.runtimeInstanceId),
			})
			.sync();
		expect(instance?.workspaceId).toBe(WORKSPACE_ID);
		expect(instance?.provider).toBe("daytona");
		expect(instance?.externalId).toBe("sbx-1");
		expect(instance?.destroyedAt).toBeNull();
	});

	test("clones from the project's GitHub url, not its local repoPath", async () => {
		const localProject = seedProject(db, REPO_URL);
		const { ctx } = makeCtx(db, calls);
		const store = new RuntimeInstanceStore(db);
		const sdk = new FakeDaytonaSdk();
		const deps: RuntimeAdapterDeps = {
			db,
			git: (async () => ({}) as never) as RuntimeAdapterDeps["git"],
			sdk: sdk as never,
			store,
			mintRepoScopedToken,
		};
		const runtime: RemoteRuntime = {
			store,
			getAdapter: () => getRuntimeAdapter("remote", deps),
		};

		await createRemoteWorkspace({
			ctx,
			localProject,
			id: WORKSPACE_ID,
			name: "Remote WS",
			branch: "feature/remote",
			taskId: undefined,
			hostPromise: Promise.resolve({ machineId: "host-1" }),
			runtime,
		});

		const sandbox = sdk.sandboxes.get("sbx-1");
		expect(sandbox?.calls.clone).toHaveLength(1);
		expect(sandbox?.calls.clone[0]?.url).toBe(REPO_URL);
		// The base ref is cloned (undefined => the repo's default branch); the
		// workspace branch is created in-sandbox after the clone, not cloned.
		expect(sandbox?.calls.clone[0]?.branch).toBeUndefined();
		expect(sandbox?.calls.executeCommand).toContain(
			"git checkout -b 'feature/remote'",
		);
	});

	test("rejects a project with no GitHub url before writing any row", async () => {
		const localProject = seedProject(db, null);
		const { ctx } = makeCtx(db, calls);
		const runtime = makeRemoteRuntime(db);

		await expect(
			createRemoteWorkspace({
				ctx,
				localProject,
				id: WORKSPACE_ID,
				name: "Remote WS",
				branch: "feature/remote",
				taskId: undefined,
				hostPromise: Promise.resolve({ machineId: "host-1" }),
				runtime,
			}),
		).rejects.toThrow(/GitHub repository URL/);

		expect(calls.create).toHaveLength(0);
		const row = db.query.workspaces
			.findFirst({ where: eq(schema.workspaces.id, WORKSPACE_ID) })
			.sync();
		expect(row).toBeUndefined();
	});

	test("rolls back the cloud + local rows when provisioning fails", async () => {
		const localProject = seedProject(db, REPO_URL);
		const { ctx } = makeCtx(db, calls);
		const store = new RuntimeInstanceStore(db);
		const failingAdapter = {
			createInstance: async () => {
				throw new Error("sandbox create failed");
			},
		};
		const runtime: RemoteRuntime = {
			store,
			getAdapter: () =>
				failingAdapter as unknown as ReturnType<typeof getRuntimeAdapter>,
		};

		await expect(
			createRemoteWorkspace({
				ctx,
				localProject,
				id: WORKSPACE_ID,
				name: "Remote WS",
				branch: "feature/remote",
				taskId: undefined,
				hostPromise: Promise.resolve({ machineId: "host-1" }),
				runtime,
			}),
		).rejects.toThrow(/Failed to provision remote runtime/);

		expect(calls.delete).toEqual([{ id: WORKSPACE_ID }]);
		const row = db.query.workspaces
			.findFirst({ where: eq(schema.workspaces.id, WORKSPACE_ID) })
			.sync();
		expect(row).toBeUndefined();
	});

	test("falls back to a generated branch name when none is supplied", async () => {
		const localProject = seedProject(db, REPO_URL);
		const { ctx } = makeCtx(db, calls);
		const runtime = makeRemoteRuntime(db);

		const result = await createRemoteWorkspace({
			ctx,
			localProject,
			id: WORKSPACE_ID,
			name: undefined,
			branch: undefined,
			taskId: undefined,
			hostPromise: Promise.resolve({ machineId: "host-1" }),
			runtime,
		});

		expect(result.workspace.branch.length).toBeGreaterThan(0);
		const row = db.query.workspaces
			.findFirst({ where: eq(schema.workspaces.id, WORKSPACE_ID) })
			.sync();
		expect(row?.branch).toBe(result.workspace.branch);
	});
});
