import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema.ts";
import { toRuntimeBinding } from "./types/index.ts";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../drizzle");
const PROJECT_ID = "1f0e8c7e-1234-4abc-8def-0123456789ab";

function migratedDb() {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	return db;
}

function seedProject(db: ReturnType<typeof migratedDb>) {
	db.insert(schema.projects)
		.values({ id: PROJECT_ID, repoPath: "/tmp/repo" })
		.run();
}

describe("host-service migrations", () => {
	test("workspace inserted without runtime fields backfills runtimeKind='local'", () => {
		const db = migratedDb();
		seedProject(db);

		db.insert(schema.workspaces)
			.values({
				id: "ws-1",
				projectId: PROJECT_ID,
				worktreePath: "/tmp/repo",
				branch: "main",
			})
			.run();

		const [row] = db
			.select()
			.from(schema.workspaces)
			.where(eq(schema.workspaces.id, "ws-1"))
			.all();

		expect(row?.runtimeKind).toBe("local");
		expect(row?.currentRuntimeId).toBeNull();
	});

	test("toRuntimeBinding maps a local row to { kind: 'local', worktreePath }", () => {
		const db = migratedDb();
		seedProject(db);
		db.insert(schema.workspaces)
			.values({
				id: "ws-2",
				projectId: PROJECT_ID,
				worktreePath: "/tmp/repo",
				branch: "main",
			})
			.run();

		const [row] = db
			.select()
			.from(schema.workspaces)
			.where(eq(schema.workspaces.id, "ws-2"))
			.all();

		expect(row).toBeDefined();
		if (!row) throw new Error("expected ws-2 workspace row");
		expect(toRuntimeBinding(row)).toEqual({
			kind: "local",
			worktreePath: "/tmp/repo",
		});
	});

	test("runtime_instances row round-trips with default metadataJson and role", () => {
		const db = migratedDb();
		seedProject(db);
		db.insert(schema.workspaces)
			.values({
				id: "ws-3",
				projectId: PROJECT_ID,
				worktreePath: "/tmp/repo",
				branch: "main",
			})
			.run();

		db.insert(schema.runtimeInstances)
			.values({
				id: "ri-1",
				workspaceId: "ws-3",
				provider: "local-worktree",
				status: "running",
			})
			.run();

		const [row] = db
			.select()
			.from(schema.runtimeInstances)
			.where(eq(schema.runtimeInstances.id, "ri-1"))
			.all();

		expect(row?.role).toBe("workspace");
		// `metadataJson` is `.$type<RuntimeMetadata>()` for compile-time safety, but
		// the column is `text` so the stored/read value is the serialized JSON
		// string at runtime; read it as such at the boundary.
		const rawMetadata = row?.metadataJson as unknown as string | undefined;
		expect(rawMetadata).toBe("{}");
		expect(JSON.parse(rawMetadata ?? "null")).toEqual({});
	});

	test("currentRuntimeId FK is set to null when the instance is deleted", () => {
		const db = migratedDb();
		seedProject(db);
		db.insert(schema.workspaces)
			.values({
				id: "ws-4",
				projectId: PROJECT_ID,
				worktreePath: "/tmp/repo",
				branch: "main",
			})
			.run();
		db.insert(schema.runtimeInstances)
			.values({
				id: "ri-2",
				workspaceId: "ws-4",
				provider: "local-worktree",
				status: "running",
			})
			.run();

		db.update(schema.workspaces)
			.set({ currentRuntimeId: "ri-2", runtimeKind: "remote" })
			.where(eq(schema.workspaces.id, "ws-4"))
			.run();

		const [linked] = db
			.select()
			.from(schema.workspaces)
			.where(eq(schema.workspaces.id, "ws-4"))
			.all();
		expect(linked?.currentRuntimeId).toBe("ri-2");

		db.delete(schema.runtimeInstances)
			.where(eq(schema.runtimeInstances.id, "ri-2"))
			.run();

		const [afterDelete] = db
			.select()
			.from(schema.workspaces)
			.where(eq(schema.workspaces.id, "ws-4"))
			.all();
		expect(afterDelete?.currentRuntimeId).toBeNull();
	});

	test("deleting a workspace cascades to its runtime_instances rows", () => {
		const db = migratedDb();
		seedProject(db);
		db.insert(schema.workspaces)
			.values({
				id: "ws-5",
				projectId: PROJECT_ID,
				worktreePath: "/tmp/repo",
				branch: "main",
			})
			.run();
		db.insert(schema.runtimeInstances)
			.values({
				id: "ri-3",
				workspaceId: "ws-5",
				provider: "local-worktree",
				status: "running",
			})
			.run();

		db.delete(schema.workspaces).where(eq(schema.workspaces.id, "ws-5")).run();

		const remaining = db
			.select()
			.from(schema.runtimeInstances)
			.where(eq(schema.runtimeInstances.workspaceId, "ws-5"))
			.all();
		expect(remaining).toHaveLength(0);
	});

	test("terminal_sessions.runtimeInstanceId is nulled on instance delete; session survives", () => {
		const db = migratedDb();
		seedProject(db);
		db.insert(schema.workspaces)
			.values({
				id: "ws-6",
				projectId: PROJECT_ID,
				worktreePath: "/tmp/repo",
				branch: "main",
			})
			.run();
		db.insert(schema.runtimeInstances)
			.values({
				id: "ri-4",
				workspaceId: "ws-6",
				provider: "local-worktree",
				status: "running",
			})
			.run();
		db.insert(schema.terminalSessions)
			.values({
				id: "ts-1",
				originWorkspaceId: "ws-6",
				runtimeInstanceId: "ri-4",
			})
			.run();

		db.delete(schema.runtimeInstances)
			.where(eq(schema.runtimeInstances.id, "ri-4"))
			.run();

		const [session] = db
			.select()
			.from(schema.terminalSessions)
			.where(eq(schema.terminalSessions.id, "ts-1"))
			.all();
		expect(session).toBeDefined();
		expect(session?.runtimeInstanceId).toBeNull();
	});
});
