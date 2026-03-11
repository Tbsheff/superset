import { verifySlackSignature } from "../verify-signature";
import { processAppHomeOpened } from "./process-app-home-opened";
import { processAssistantMessage } from "./process-assistant-message";
import { processEntityDetails } from "./process-entity-details";
import { processLinkShared } from "./process-link-shared";
import { processSlackMention } from "./process-mention";

export async function POST(request: Request) {
	const body = await request.text();
	const signature = request.headers.get("x-slack-signature");
	const timestamp = request.headers.get("x-slack-request-timestamp");

	if (!signature || !timestamp) {
		return Response.json(
			{ error: "Missing signature headers" },
			{ status: 401 },
		);
	}

	if (!verifySlackSignature({ body, signature, timestamp })) {
		console.error("[slack/events] Signature verification failed");
		return Response.json({ error: "Invalid signature" }, { status: 401 });
	}

	const payload = JSON.parse(body);

	// Slack sends this once when configuring the Events URL
	if (payload.type === "url_verification") {
		return Response.json({ challenge: payload.challenge });
	}

	if (payload.type === "event_callback") {
		const { event, team_id, event_id } = payload;

		if (event.type === "app_mention") {
			processSlackMention({
				event,
				teamId: team_id,
				eventId: event_id,
			}).catch((err: unknown) => {
				console.error("[slack/events] Process mention error:", err);
			});
		}

		if (event.type === "message" && event.channel_type === "im") {
			// Skip bot messages to prevent infinite loops
			if (event.bot_id || event.subtype === "bot_message" || !event.user) {
				return new Response("ok", { status: 200 });
			}

			processAssistantMessage({
				event,
				teamId: team_id,
				eventId: event_id,
			}).catch((err: unknown) => {
				console.error("[slack/events] Process assistant message error:", err);
			});
		}

		if (event.type === "link_shared") {
			processLinkShared({
				event,
				teamId: team_id,
				eventId: event_id,
			}).catch((err: unknown) => {
				console.error("[slack/events] Process link shared error:", err);
			});
		}

		if (event.type === "entity_details_requested") {
			processEntityDetails({
				event,
				teamId: team_id,
				eventId: event_id,
			}).catch((err: unknown) => {
				console.error("[slack/events] Process entity details error:", err);
			});
		}

		if (event.type === "app_home_opened") {
			processAppHomeOpened({
				event,
				teamId: team_id,
				eventId: event_id,
			}).catch((err: unknown) => {
				console.error("[slack/events] Process app home opened error:", err);
			});
		}
	}

	// Slack requires 200 within 3s regardless of event type
	return new Response("ok", { status: 200 });
}
