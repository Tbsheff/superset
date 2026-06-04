import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { HostDb } from "../../db/index.ts";
import * as schema from "../../db/schema.ts";
import type { RuntimeInstanceRecord } from "../adapters/daytona/types.ts";
import { RuntimeInstanceStore } from "./runtimeInstanceStore.ts";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../../drizzle");
const PROJECT_ID = "1f0e8c7e-1234-4abc-8def-0123456789ab";
const WORKSPACE_ID = "ws-store-1";

function migratedDb(): HostDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	return db as unknown as HostDb;
}

function seedWorkspace(db: HostDb, workspaceId = WORKSPACE_ID): void {
	db.insert(schema.projects)
		.values({ id: PROJECT_ID, repoPath: "/tmp/repo" })
		.onConflictDoNothing()
		.run();
	db.insert(schema.workspaces)
		.values({
			id: workspaceId,
			projectId: PROJECT_ID,
			worktreePath: "/tmp/repo",
			branch: "main",
		})
		.run();
}

function makeRecord(
	overrides: Partial<RuntimeInstanceRecord> = {},
): RuntimeInstanceRecord {
	return {
		id: "ri-1",
		workspaceId: WORKSPACE_ID,
		provider: "daytona",
		role: "workspace",
		externalId: "sbx-1",
		status: "running",
		previewUrl: null,
		lastActivityAt: 1_000,
		metadataJson: { target: "us" },
		createdAt: 1_000,
		destroyedAt: null,
		failureReason: null,
		...overrides,
	};
}

describe("RuntimeInstanceStore", () => {
	let db: HostDb;
	let store: RuntimeInstanceStore;

	beforeEach(() => {
		db = migratedDb();
		store = new RuntimeInstanceStore(db);
		seedWorkspace(db);
	});

	test("insert then get round-trips the full record", () => {
		const record = makeRecord();
		store.insert(record);
		expect(store.get("sbx-1")).toEqual(record);
	});

	test("insert serializes metadataJson as a text JSON string in the column", () => {
		store.insert(makeRecord({ metadataJson: { target: "us", region: null } }));
		const [row] = db
			.select()
			.from(schema.runtimeInstances)
			.where(eq(schema.runtimeInstances.id, "ri-1"))
			.all();
		const raw = row?.metadataJson as unknown as string;
		expect(typeof raw).toBe("string");
		expect(JSON.parse(raw)).toEqual({ target: "us", region: null });
	});

	test("get reads metadataJson back into an object", () => {
		store.insert(makeRecord({ metadataJson: { nested: { a: 1, b: [2, 3] } } }));
		expect(store.get("sbx-1")?.metadataJson).toEqual({
			nested: { a: 1, b: [2, 3] },
		});
	});

	test("get returns undefined for an unknown externalId", () => {
		expect(store.get("missing")).toBeUndefined();
	});

	test("getByExternalId aliases get", () => {
		store.insert(makeRecord());
		expect(store.getByExternalId("sbx-1")).toEqual(store.get("sbx-1"));
		expect(store.getByExternalId("missing")).toBeUndefined();
	});

	test("setPreviewUrl updates only the addressed row", () => {
		store.insert(makeRecord());
		store.setPreviewUrl("sbx-1", "https://3000-sbx-1.proxy.daytona.test");
		expect(store.get("sbx-1")?.previewUrl).toBe(
			"https://3000-sbx-1.proxy.daytona.test",
		);
	});

	test("markDestroyed sets destroyedAt and collapses status to stopped", () => {
		store.insert(makeRecord());
		store.markDestroyed("sbx-1", 5_000);
		const row = store.get("sbx-1");
		expect(row?.destroyedAt).toBe(5_000);
		expect(row?.status).toBe("stopped");
	});

	test("markDestroyed on an unknown externalId is a no-op", () => {
		store.insert(makeRecord());
		store.markDestroyed("missing", 5_000);
		expect(store.get("sbx-1")?.destroyedAt).toBeNull();
	});

	test("getByWorkspaceId returns the live instance for a workspace", () => {
		store.insert(makeRecord());
		const found = store.getByWorkspaceId(WORKSPACE_ID);
		expect(found?.id).toBe("ri-1");
		expect(found?.externalId).toBe("sbx-1");
	});

	test("getByWorkspaceId skips destroyed instances", () => {
		store.insert(makeRecord());
		store.markDestroyed("sbx-1", 5_000);
		expect(store.getByWorkspaceId(WORKSPACE_ID)).toBeUndefined();
	});

	test("getByWorkspaceId returns the newest live instance after a re-provision", () => {
		store.insert(
			makeRecord({ id: "ri-old", externalId: "sbx-old", createdAt: 1_000 }),
		);
		store.markDestroyed("sbx-old", 1_500);
		store.insert(
			makeRecord({ id: "ri-new", externalId: "sbx-new", createdAt: 2_000 }),
		);
		const found = store.getByWorkspaceId(WORKSPACE_ID);
		expect(found?.id).toBe("ri-new");
		expect(found?.externalId).toBe("sbx-new");
	});

	test("getByWorkspaceId returns undefined when the workspace has no instances", () => {
		seedWorkspace(db, "ws-store-empty");
		expect(store.getByWorkspaceId("ws-store-empty")).toBeUndefined();
	});

	test("insert persists null previewUrl/lastActivityAt/failureReason", () => {
		store.insert(
			makeRecord({
				previewUrl: null,
				lastActivityAt: null,
				failureReason: null,
			}),
		);
		const row = store.get("sbx-1");
		expect(row?.previewUrl).toBeNull();
		expect(row?.lastActivityAt).toBeNull();
		expect(row?.failureReason).toBeNull();
	});

	test("get tolerates a row whose metadataJson is the default '{}' string", () => {
		seedWorkspace(db, "ws-default-meta");
		db.insert(schema.runtimeInstances)
			.values({
				id: "ri-default",
				workspaceId: "ws-default-meta",
				provider: "daytona",
				externalId: "sbx-default",
				status: "running",
			})
			.run();
		expect(store.get("sbx-default")?.metadataJson).toEqual({});
	});
});
