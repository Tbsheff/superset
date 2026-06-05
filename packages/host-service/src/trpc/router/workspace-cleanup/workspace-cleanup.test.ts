import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { HostDb } from "../../../db/index.ts";
import * as schema from "../../../db/schema.ts";
import { RuntimeInstanceStore } from "../../../runtime/store/index.ts";
import type { HostServiceContext } from "../../../types.ts";
import { destroyWorkspace } from "./workspace-cleanup.ts";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../../../drizzle");
const PROJECT_ID = "1f0e8c7e-1234-4abc-8def-0123456789ab";
const REMOTE_WS_ID = "3b2c4d5e-6789-4abc-8def-0123456789ab";
const LOCAL_WS_ID = "2a1b3c4d-5678-4abc-8def-0123456789ab";

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

/** Remote workspace + its live runtime_instances row (no local worktree). */
function seedRemoteWorkspace(db: HostDb): void {
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
	store.insert({
		id: "ri-1",
		workspaceId: REMOTE_WS_ID,
		provider: "daytona",
		role: "workspace",
		externalId: "sbx-remote",
		status: "running" as never,
		previewUrl: null,
		lastActivityAt: Date.now(),
		metadataJson: {},
		createdAt: Date.now(),
		destroyedAt: null,
		failureReason: null,
	});
	db.update(schema.workspaces)
		.set({ currentRuntimeId: "ri-1" })
		.where(eq(schema.workspaces.id, REMOTE_WS_ID))
		.run();
}

function seedLocalWorkspace(db: HostDb): void {
	db.insert(schema.workspaces)
		.values({
			id: LOCAL_WS_ID,
			projectId: PROJECT_ID,
			worktreePath: "/tmp/repo/wt-does-not-exist",
			branch: "feature/local",
			runtimeKind: "local",
		})
		.run();
}

interface FakeCtxParts {
	db: HostDb;
	deleteCalls: { id: string }[];
}

function makeCtx(db: HostDb): { ctx: HostServiceContext; parts: FakeCtxParts } {
	const deleteCalls: { id: string }[] = [];
	const ctx = {
		db,
		organizationId: "org-1",
		api: {
			v2Workspace: {
				// isMainWorkspace consults this; a non-"main" type lets destroy proceed.
				getFromHost: { query: async () => ({ type: "branch" }) },
				delete: {
					mutate: async (input: { id: string }) => {
						deleteCalls.push(input);
						return { success: true };
					},
				},
			},
		},
		// ctx.git is only reached for local worktree ops, which a remote ws skips.
		git: async () => {
			throw new Error("ctx.git must not be called for a remote workspace");
		},
	} as unknown as HostServiceContext;
	return { ctx, parts: { db, deleteCalls } };
}

describe("destroyWorkspace remote", () => {
	let db: HostDb;

	beforeEach(() => {
		db = migratedDb();
		seedProject(db);
	});

	test("remote: calls adapter.destroy with the live externalId and {kind:'delete'}", async () => {
		seedRemoteWorkspace(db);
		const { ctx, parts } = makeCtx(db);
		const destroy = mock(async (_workspaceId: string) => ({
			kind: "destroyed" as const,
			externalId: "sbx-remote",
		}));

		const result = await destroyWorkspace(ctx, {
			workspaceId: REMOTE_WS_ID,
			deleteBranch: false,
			force: false,
			remoteDestroyer: { destroy },
		});

		expect(destroy).toHaveBeenCalledTimes(1);
		expect(destroy.mock.calls[0]?.[0]).toBe(REMOTE_WS_ID);
		// Cloud delete still committed; no warnings on a clean destroy.
		expect(parts.deleteCalls).toEqual([{ id: REMOTE_WS_ID }]);
		expect(result.success).toBe(true);
		expect(result.warnings).toEqual([]);
		// Remote has no local worktree; it reports already-removed.
		expect(result.worktreeRemoved).toBe(true);
	});

	test("remote: a destroy error becomes a warning, not a thrown failure", async () => {
		seedRemoteWorkspace(db);
		const { ctx, parts } = makeCtx(db);
		const destroy = mock(async (_workspaceId: string) => ({
			kind: "error" as const,
			message: "sandbox unreachable",
		}));

		const result = await destroyWorkspace(ctx, {
			workspaceId: REMOTE_WS_ID,
			deleteBranch: false,
			force: false,
			remoteDestroyer: { destroy },
		});

		expect(result.success).toBe(true);
		expect(parts.deleteCalls).toEqual([{ id: REMOTE_WS_ID }]);
		expect(result.warnings.some((w) => w.includes("sandbox unreachable"))).toBe(
			true,
		);
	});

	test("remote: destroy runs before the cloud delete", async () => {
		seedRemoteWorkspace(db);
		const order: string[] = [];
		const deleteCalls: { id: string }[] = [];
		const ctx = {
			db,
			organizationId: "org-1",
			api: {
				v2Workspace: {
					getFromHost: { query: async () => ({ type: "branch" }) },
					delete: {
						mutate: async (input: { id: string }) => {
							order.push("cloud-delete");
							deleteCalls.push(input);
							return { success: true };
						},
					},
				},
			},
			git: async () => {
				throw new Error("git must not be called");
			},
		} as unknown as HostServiceContext;
		const destroy = mock(async (_workspaceId: string) => {
			order.push("sandbox-destroy");
			return { kind: "destroyed" as const, externalId: "sbx-remote" };
		});

		await destroyWorkspace(ctx, {
			workspaceId: REMOTE_WS_ID,
			deleteBranch: false,
			force: false,
			remoteDestroyer: { destroy },
		});

		expect(order).toEqual(["sandbox-destroy", "cloud-delete"]);
	});

	test("local: never reaches the remote destroyer", async () => {
		seedLocalWorkspace(db);
		const { ctx } = makeCtx(db);
		const destroy = mock(async (_workspaceId: string) => ({
			kind: "no-runtime" as const,
		}));

		// A local workspace whose worktree dir is missing: cleanup degrades to a
		// no-op worktree removal and the remote destroyer is never consulted.
		await destroyWorkspace(ctx, {
			workspaceId: LOCAL_WS_ID,
			deleteBranch: false,
			force: true,
			remoteDestroyer: { destroy },
		});

		expect(destroy).not.toHaveBeenCalled();
	});
});
