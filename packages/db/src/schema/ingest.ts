import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const webhookEvents = sqliteTable(
	"ingest_webhook_events",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),

		// Source
		provider: text("provider").notNull(),
		eventId: text("event_id").notNull(),
		eventType: text("event_type"),

		// Raw payload
		payload: text("payload", { mode: "json" }).notNull(),

		// Processing state
		status: text("status").notNull().default("pending"),
		processedAt: integer("processed_at", { mode: "timestamp" }),
		error: text("error"),
		retryCount: integer("retry_count").notNull().default(0),

		receivedAt: integer("received_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		index("webhook_events_provider_status_idx").on(
			table.provider,
			table.status,
		),
		uniqueIndex("webhook_events_provider_event_id_idx").on(
			table.provider,
			table.eventId,
		),
		index("webhook_events_received_at_idx").on(table.receivedAt),
	],
);

export type InsertWebhookEvent = typeof webhookEvents.$inferInsert;
export type SelectWebhookEvent = typeof webhookEvents.$inferSelect;
