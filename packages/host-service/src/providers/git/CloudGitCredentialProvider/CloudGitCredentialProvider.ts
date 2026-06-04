import { unlink } from "node:fs/promises";
import type { GitCredentialProvider } from "../../../runtime/git/types";
import { GIT_ASKPASS_TOKEN_ENV, writeTempAskpass } from "./askpass";
import { repoCacheKey } from "./repoCacheKey";

interface CachedCredential {
	expiresAt: number;
	askpassPath: string;
	token: string;
}

export class CloudGitCredentialProvider implements GitCredentialProvider {
	private tokenFetcher: (
		remoteUrl: string,
	) => Promise<{ token: string; expiresAt: number }>;
	private cachedCredentials = new Map<string, CachedCredential>();
	private cachedToken: { token: string; expiresAt: number } | null = null;

	constructor(
		tokenFetcher: (
			remoteUrl: string,
		) => Promise<{ token: string; expiresAt: number }>,
	) {
		this.tokenFetcher = tokenFetcher;
	}

	async getCredentials(
		remoteUrl: string | null,
	): Promise<{ env: Record<string, string> }> {
		if (!remoteUrl) {
			return { env: { GIT_TERMINAL_PROMPT: "0" } };
		}

		const cacheKey = repoCacheKey(remoteUrl);
		const cached = this.cachedCredentials.get(cacheKey);

		if (cached && cached.expiresAt > Date.now()) {
			return {
				env: {
					GIT_ASKPASS: cached.askpassPath,
					[GIT_ASKPASS_TOKEN_ENV]: cached.token,
					GIT_TERMINAL_PROMPT: "0",
				},
			};
		}

		if (cached?.askpassPath) {
			unlink(cached.askpassPath).catch(() => {});
		}

		const { token, expiresAt } = await this.tokenFetcher(remoteUrl);
		const askpassPath = await writeTempAskpass();

		this.cachedCredentials.set(cacheKey, { expiresAt, askpassPath, token });

		return {
			env: {
				GIT_ASKPASS: askpassPath,
				[GIT_ASKPASS_TOKEN_ENV]: token,
				GIT_TERMINAL_PROMPT: "0",
			},
		};
	}

	async getToken(_host: string): Promise<string | null> {
		if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
			return this.cachedToken.token;
		}

		try {
			const result = await this.tokenFetcher("https://github.com");
			this.cachedToken = result;
			return result.token;
		} catch {
			return null;
		}
	}
}
