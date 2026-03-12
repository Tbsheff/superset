import { db } from "@superset/db/client";
import { tasks } from "@superset/db/schema";
import { eq } from "drizzle-orm";
import { syncTaskToLinearById } from "../../../router/integration/linear/sync";

const PROVIDER_SYNC: Record<
	string,
	(taskId: string) => Promise<{ success: boolean; error?: string }>
> = {
	linear: syncTaskToLinearById,
};

export async function syncTask(taskId: string) {
	const task = await db.query.tasks.findFirst({
		where: eq(tasks.id, taskId),
		columns: { externalProvider: true },
	});

	if (!task) {
		throw new Error("Task not found");
	}

	const connections = await db.query.integrationConnections.findMany({
		columns: { provider: true },
	});

	const results = await Promise.allSettled(
		connections.map(async (conn) => {
			const syncFn = PROVIDER_SYNC[conn.provider];
			if (!syncFn) {
				return { provider: conn.provider, skipped: true };
			}

			await syncFn(taskId);
			return { provider: conn.provider, synced: true };
		}),
	);

	return results;
}
