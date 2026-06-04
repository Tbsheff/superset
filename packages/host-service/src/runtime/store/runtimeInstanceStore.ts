import { and, desc, eq, isNull } from "drizzle-orm";
import type { HostDb } from "../../db/index.ts";
import { runtimeInstances } from "../../db/schema.ts";
import type { RuntimeMetadata } from "../../db/types/index.ts";
import type {
	DaytonaInstanceStore,
	RuntimeInstanceRecord,
} from "../adapters/daytona/types.ts";

/**
 * Production `DaytonaInstanceStore` backed by the host SQLite `runtime_instances`
 * table. The adapter writes through the synchronous `insert/setPreviewUrl/
 * markDestroyed/get` seam; this is the first and only production reader/writer of
 * the table (everything before it used `FakeInstanceStore`). The drizzle
 * better-sqlite3/bun-sqlite driver is synchronous, so the void-returning seam
 * maps onto `.run()`/`.get()` directly without leaking a Promise.
 *
 * `metadataJson` is a `text` column carrying serialized JSON. Drizzle's
 * `.$type<RuntimeMetadata>()` is compile-time only, so this store
 * stringifies on write and parses on read at the boundary. By contract the
 * adapter only ever puts NON-secret provider extras there (see adapter.ts
 * `persistInstance`); the `RuntimeMetadata` brand keeps a `Secret` from compiling
 * into the object in the first place.
 */
export class RuntimeInstanceStore implements DaytonaInstanceStore {
	constructor(private readonly db: HostDb) {}

	insert(record: RuntimeInstanceRecord): void {
		this.db
			.insert(runtimeInstances)
			.values({
				id: record.id,
				workspaceId: record.workspaceId,
				provider: record.provider,
				role: record.role,
				externalId: record.externalId,
				status: record.status,
				previewUrl: record.previewUrl,
				lastActivityAt: record.lastActivityAt,
				ttlExpiresAt: null,
				metadataJson: serializeMetadata(record.metadataJson),
				createdAt: record.createdAt,
				destroyedAt: record.destroyedAt,
				failureReason: record.failureReason,
			})
			.run();
	}

	setPreviewUrl(externalId: string, previewUrl: string): void {
		this.db
			.update(runtimeInstances)
			.set({ previewUrl })
			.where(eq(runtimeInstances.externalId, externalId))
			.run();
	}

	/**
	 * Records the local destroyed transition. The stored vocabulary has no
	 * `destroyed` member, so a torn-down instance is `status: "stopped"` plus a
	 * `destroyedAt` timestamp — mirroring `FakeInstanceStore` and the
	 * `toStoredStatus` contract.
	 */
	markDestroyed(externalId: string, destroyedAt: number): void {
		this.db
			.update(runtimeInstances)
			.set({ destroyedAt, status: "stopped" })
			.where(eq(runtimeInstances.externalId, externalId))
			.run();
	}

	get(externalId: string): RuntimeInstanceRecord | undefined {
		const row = this.db
			.select()
			.from(runtimeInstances)
			.where(eq(runtimeInstances.externalId, externalId))
			.get();
		return row ? toRecord(row) : undefined;
	}

	/** Alias of `get` for callers that key explicitly by provider external id. */
	getByExternalId(externalId: string): RuntimeInstanceRecord | undefined {
		return this.get(externalId);
	}

	/**
	 * Most-recent live instance for a workspace, used by later steps (PTY
	 * endpoint, diff, cleanup) to resolve `workspace.currentRuntimeId`'s peer.
	 * "Live" = not yet `markDestroyed`; a workspace can have stale destroyed rows
	 * from prior provisions, so this filters them out and returns the newest.
	 */
	getByWorkspaceId(workspaceId: string): RuntimeInstanceRecord | undefined {
		const row = this.db
			.select()
			.from(runtimeInstances)
			.where(
				and(
					eq(runtimeInstances.workspaceId, workspaceId),
					isNull(runtimeInstances.destroyedAt),
				),
			)
			.orderBy(desc(runtimeInstances.createdAt))
			.get();
		return row ? toRecord(row) : undefined;
	}
}

type RuntimeInstanceRow = typeof runtimeInstances.$inferSelect;

function toRecord(row: RuntimeInstanceRow): RuntimeInstanceRecord {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		provider: row.provider,
		role: row.role,
		externalId: row.externalId,
		status: row.status,
		previewUrl: row.previewUrl,
		lastActivityAt: row.lastActivityAt,
		metadataJson: parseMetadata(row.metadataJson),
		createdAt: row.createdAt,
		destroyedAt: row.destroyedAt,
		failureReason: row.failureReason,
	};
}

/**
 * Serializes metadata for the `text` column. The column is declared
 * `.$type<RuntimeMetadata>()`, so drizzle's insert types expect the object even
 * though the value persisted at runtime is the JSON string (see
 * `migrations.test.ts`). The single cast here is the one place that boundary lie
 * lives; `parseMetadata` reverses it on read.
 */
function serializeMetadata(metadata: RuntimeMetadata): RuntimeMetadata {
	return JSON.stringify(metadata ?? {}) as unknown as RuntimeMetadata;
}

/**
 * Reads the serialized `metadataJson` text back into a `RuntimeMetadata`. The
 * column is declared `.$type<RuntimeMetadata>()` so its static type is the
 * object, but at runtime it is the stored string; an unexpected non-object (bad
 * write, manual edit) falls back to `{}` rather than throwing on read.
 */
function parseMetadata(
	value: RuntimeMetadata | string | null,
): RuntimeMetadata {
	if (value == null) return {};
	if (typeof value === "object") return value;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return {};
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}
	return parsed as RuntimeMetadata;
}
