import { getTableColumns, type SQL, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

export function buildConflictUpdateColumns<
	T extends SQLiteTable,
	Q extends keyof T["_"]["columns"],
>(table: T, columns: Q[]): Record<Q, SQL> {
	const cls = getTableColumns(table);
	return columns.reduce(
		(acc, column) => {
			const col = cls[column as string];
			acc[column] = sql.raw(`excluded.${col?.name}`);
			return acc;
		},
		{} as Record<Q, SQL>,
	);
}
