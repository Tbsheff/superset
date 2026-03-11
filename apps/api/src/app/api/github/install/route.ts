import { auth } from "@superset/auth/server";

import { env } from "@/env";
import { createSignedState } from "@/lib/oauth-state";

export async function GET(request: Request) {
	const session = await auth.api.getSession({ headers: request.headers });

	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	if (!env.GH_APP_ID) {
		return Response.json(
			{ error: "GitHub App not configured" },
			{ status: 500 },
		);
	}

	const state = createSignedState({
		userId: session.user.id,
	});

	const installUrl = new URL(
		"https://github.com/apps/superset-app/installations/new",
	);
	installUrl.searchParams.set("state", state);
	installUrl.searchParams.set(
		"redirect_url",
		`${env.NEXT_PUBLIC_API_URL}/api/github/callback`,
	);

	return Response.redirect(installUrl.toString());
}
