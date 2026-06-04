import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { HostDb } from "../../db/index.ts";
import * as schema from "../../db/schema.ts";
import type { HostServiceContext } from "../../types.ts";
import type { RemoteWorkspaceDestroyer } from "./destroyRemoteWorkspace.ts";
import { reapOrphanedSandboxes } from "./sandboxReaper.ts";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../../drizzle");
const PROJECT_ID = "1f0e8c7e-1234-4abc-8def-0123456789ab";

function migratedDb(): HostDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	return db as unknown as HostDb;
}

function seedInstance(
	db: HostDb,
	args: {
		workspaceId: string;
		externalId: string;
		provider?: string;
		destroyedAt?: number | null;
	},
): void {
	db.insert(schema.projects)
		.values({ id: PROJECT_ID, repoPath: "/tmp/repo" })
		.onConflictDoNothing()
		.run();
	db.insert(schema.workspaces)
		.values({
			id: args.workspaceId,
			projectId: PROJECT_ID,
			worktreePath: "",
			branch: "main",
			runtimeKind: "remote",
		})
		.onConflictDoNothing()
		.run();
	db.insert(schema.runtimeInstances)
		.values({
			id: `ri-${args.externalId}`,
			workspaceId: args.workspaceId,
			provider: args.provider ?? "daytona",
			role: "workspace",
			externalId: args.externalId,
			status: "running",
			createdAt: 1_000,
			destroyedAt: args.destroyedAt ?? null,
		})
		.run();
}

function makeCtx(
	db: HostDb,
	listImpl: () => Promise<Array<{ id: string }>>,
): HostServiceContext {
	return {
		db,
		organizationId: "org-1",
		api: {
			v2Workspace: { list: { query: async () => listImpl() } },
		},
	} as unknown as HostServiceContext;
}

function recordingDestroyer(): {
	destroyer: RemoteWorkspaceDestroyer;
	destroyed: string[];
} {
	const destroyed: string[] = [];
	return {
		destroyed,
		destroyer: {
			async destroy(workspaceId) {
				destroyed.push(workspaceId);
				return { kind: "destroyed", externalId: `sbx-${workspaceId}` };
			},
		},
	};
}

describe("reapOrphanedSandboxes", () => {
	test("destroys sandboxes whose workspace is gone from the cloud, keeps the rest", async () => {
		const db = migratedDb();
		seedInstance(db, { workspaceId: "ws-live", externalId: "sbx-live" });
		seedInstance(db, { workspaceId: "ws-orphan", externalId: "sbx-orphan" });
		const { destroyer, destroyed } = recordingDestroyer();

		const result = await reapOrphanedSandboxes(
			makeCtx(db, async () => [{ id: "ws-live" }]),
			{ destroyer },
		);

		expect(destroyed).toEqual(["ws-orphan"]);
		expect(result.reaped).toEqual(["sbx-orphan"]);
		expect(result.errors).toHaveLength(0);
	});

	test("never reaps when the cloud list fails (transient failure is not 'all deleted')", async () => {
		const db = migratedDb();
		seedInstance(db, { workspaceId: "ws-orphan", externalId: "sbx-orphan" });
		const { destroyer, destroyed } = recordingDestroyer();

		const result = await reapOrphanedSandboxes(
			makeCtx(db, async () => {
				throw new Error("cloud down");
			}),
			{ destroyer },
		);

		expect(destroyed).toHaveLength(0);
		expect(result.reaped).toHaveLength(0);
		expect(result.errors[0]).toContain("cloud workspace list failed");
	});

	test("ignores already-destroyed instances", async () => {
		const db = migratedDb();
		seedInstance(db, {
			workspaceId: "ws-gone",
			externalId: "sbx-gone",
			destroyedAt: 5_000,
		});
		const { destroyer, destroyed } = recordingDestroyer();

		const result = await reapOrphanedSandboxes(
			makeCtx(db, async () => []),
			{ destroyer },
		);

		expect(destroyed).toHaveLength(0);
		expect(result.reaped).toHaveLength(0);
	});
});
