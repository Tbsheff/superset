import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";

import { env } from "@/env";

function createGithubApp() {
	if (!env.GH_APP_ID || !env.GH_APP_PRIVATE_KEY || !env.GH_WEBHOOK_SECRET) {
		return null;
	}
	return new App({
		appId: env.GH_APP_ID,
		privateKey: env.GH_APP_PRIVATE_KEY,
		webhooks: { secret: env.GH_WEBHOOK_SECRET },
		Octokit: Octokit,
	});
}

export const githubApp = createGithubApp();
