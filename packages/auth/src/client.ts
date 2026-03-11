"use client";

import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import type { auth } from "@superset/auth/server";
import {
	apiKeyClient,
	customSessionClient,
	organizationClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
	baseURL: process.env.NEXT_PUBLIC_API_URL,
	plugins: [
		organizationClient(),
		customSessionClient<typeof auth>(),
		apiKeyClient(),
		oauthProviderClient(),
	],
});
