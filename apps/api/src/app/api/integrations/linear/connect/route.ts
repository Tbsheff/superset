import { auth } from "@superset/auth/server";

import { env } from "@/env";
import { createSignedState } from "@/lib/oauth-state";

export async function GET(request: Request) {
	if (!env.LINEAR_CLIENT_ID) {
		return Response.json(
			{ error: "Linear integration not configured" },
			{ status: 503 },
		);
	}

	const session = await auth.api.getSession({
		headers: request.headers,
	});

	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const state = createSignedState({
		userId: session.user.id,
	});

	const linearAuthUrl = new URL("https://linear.app/oauth/authorize");
	linearAuthUrl.searchParams.set("client_id", env.LINEAR_CLIENT_ID);
	linearAuthUrl.searchParams.set(
		"redirect_uri",
		`${env.NEXT_PUBLIC_API_URL}/api/integrations/linear/callback`,
	);
	linearAuthUrl.searchParams.set("response_type", "code");
	linearAuthUrl.searchParams.set("scope", "read,write,issues:create");
	linearAuthUrl.searchParams.set("state", state);

	return Response.redirect(linearAuthUrl.toString());
}
