import { z } from "zod";

import { processAssistantMessage } from "../../events/process-assistant-message";

const slackFileSchema = z.object({
	id: z.string(),
	name: z.string().optional(),
	mimetype: z.string().optional(),
	size: z.number().optional(),
	url_private: z.string().optional(),
	url_private_download: z.string().optional(),
});

const payloadSchema = z.object({
	event: z.object({
		type: z.literal("message"),
		user: z.string(),
		text: z.string().optional(),
		ts: z.string(),
		channel: z.string(),
		channel_type: z.literal("im"),
		event_ts: z.string(),
		thread_ts: z.string().optional(),
		files: z.array(slackFileSchema).optional(),
	}),
	teamId: z.string(),
	eventId: z.string(),
});

export async function POST(request: Request) {
	const body = await request.text();

	const parsed = payloadSchema.safeParse(JSON.parse(body));
	if (!parsed.success) {
		console.error(
			"[slack/process-assistant-message] Invalid payload:",
			parsed.error,
		);
		return Response.json({ error: "Invalid payload" }, { status: 400 });
	}

	await processAssistantMessage({
		event: parsed.data.event,
		teamId: parsed.data.teamId,
		eventId: parsed.data.eventId,
	});

	return Response.json({ success: true });
}
