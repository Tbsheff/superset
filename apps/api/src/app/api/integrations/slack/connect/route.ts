import { LOCAL_USER_ID } from "@superset/shared/constants";

import { env } from "@/env";
import { createSignedState } from "@/lib/oauth-state";

const SLACK_SCOPES = [
	"app_mentions:read",
	"chat:write",
	"reactions:write",
	"channels:history",
	"groups:history",
	"im:history",
	"im:read",
	"im:write",
	"mpim:history",
	"users:read",
	"files:read",
	"assistant:write",
	"links:read",
	"links:write",
].join(",");

export async function GET(_request: Request) {
	if (!env.SLACK_CLIENT_ID) {
		return Response.json(
			{ error: "Slack integration not configured" },
			{ status: 503 },
		);
	}

	const state = createSignedState({
		userId: LOCAL_USER_ID,
	});

	const redirectUri = `${env.NEXT_PUBLIC_API_URL}/api/integrations/slack/callback`;

	const slackAuthUrl = new URL("https://slack.com/oauth/v2/authorize");
	slackAuthUrl.searchParams.set("client_id", env.SLACK_CLIENT_ID);
	slackAuthUrl.searchParams.set("redirect_uri", redirectUri);
	slackAuthUrl.searchParams.set("scope", SLACK_SCOPES);
	slackAuthUrl.searchParams.set("state", state);

	return Response.redirect(slackAuthUrl.toString());
}
