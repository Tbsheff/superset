import { db } from "@superset/db/client";
import { tasks } from "@superset/db/schema";
import {
	getNewTasksTeamId,
	syncTaskToLinear,
} from "@superset/trpc/integrations/linear";
import { eq } from "drizzle-orm";
import { z } from "zod";

const payloadSchema = z.object({
	taskId: z.string().min(1),
	teamId: z.string().optional(),
});

export async function POST(request: Request) {
	const body = await request.text();

	const parsed = payloadSchema.safeParse(JSON.parse(body));
	if (!parsed.success) {
		return Response.json({ error: "Invalid payload" }, { status: 400 });
	}

	const { taskId, teamId } = parsed.data;

	const task = await db.query.tasks.findFirst({
		where: eq(tasks.id, taskId),
	});

	if (!task) {
		return Response.json({ error: "Task not found", skipped: true });
	}

	const resolvedTeamId = teamId ?? (await getNewTasksTeamId());
	if (!resolvedTeamId) {
		return Response.json({ error: "No team configured", skipped: true });
	}

	const result = await syncTaskToLinear(task, resolvedTeamId);

	if (!result.success) {
		return Response.json({ error: result.error }, { status: 500 });
	}

	return Response.json({
		success: true,
		externalId: result.externalId,
		externalKey: result.externalKey,
	});
}
