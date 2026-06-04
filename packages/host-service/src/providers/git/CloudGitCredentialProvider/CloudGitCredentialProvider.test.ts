import { readFile, unlink } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";
import { CloudGitCredentialProvider } from "./CloudGitCredentialProvider";
import { repoCacheKey } from "./repoCacheKey";

const HOUR_MS = 60 * 60 * 1000;
const createdAskpassPaths = new Set<string>();

function trackAskpass(env: Record<string, string>): string {
	const path = env.GIT_ASKPASS;
	if (path) createdAskpassPaths.add(path);
	return path ?? "";
}

async function tokenFromAskpass(askpassPath: string): Promise<string> {
	const script = await readFile(askpassPath, "utf8");
	const match = script.match(/echo "([^"]+)" ;;\n?esac/);
	return match?.[1] ?? "";
}

afterEach(async () => {
	for (const path of createdAskpassPaths) {
		await unlink(path).catch(() => {});
	}
	createdAskpassPaths.clear();
});

describe("CloudGitCredentialProvider per-repo cache", () => {
	test("two different repos get distinct cached entries (no token sharing)", async () => {
		const calls: string[] = [];
		const provider = new CloudGitCredentialProvider(async (remoteUrl) => {
			calls.push(remoteUrl);
			return {
				token: `token-for-${repoCacheKey(remoteUrl)}`,
				expiresAt: Date.now() + HOUR_MS,
			};
		});

		const repoA = "https://github.com/acme/alpha.git";
		const repoB = "https://github.com/acme/beta.git";

		const credsA = await provider.getCredentials(repoA);
		const credsB = await provider.getCredentials(repoB);

		const pathA = trackAskpass(credsA.env);
		const pathB = trackAskpass(credsB.env);

		expect(pathA).not.toBe(pathB);
		expect(calls).toEqual([repoA, repoB]);

		const tokenA = await tokenFromAskpass(pathA);
		const tokenB = await tokenFromAskpass(pathB);
		expect(tokenA).toBe("token-for-github.com/acme/alpha");
		expect(tokenB).toBe("token-for-github.com/acme/beta");
		expect(tokenA).not.toBe(tokenB);
	});

	test("same repo reuses its cached entry within expiry", async () => {
		const calls: string[] = [];
		const provider = new CloudGitCredentialProvider(async (remoteUrl) => {
			calls.push(remoteUrl);
			return { token: "scoped-token", expiresAt: Date.now() + HOUR_MS };
		});

		const repo = "https://github.com/acme/alpha.git";

		const first = await provider.getCredentials(repo);
		const second = await provider.getCredentials(repo);

		trackAskpass(first.env);
		trackAskpass(second.env);

		expect(first.env.GIT_ASKPASS).toBe(second.env.GIT_ASKPASS);
		expect(calls).toEqual([repo]);
	});

	test("same repo across different URL forms reuses one entry", async () => {
		const calls: string[] = [];
		const provider = new CloudGitCredentialProvider(async (remoteUrl) => {
			calls.push(remoteUrl);
			return { token: "scoped-token", expiresAt: Date.now() + HOUR_MS };
		});

		const httpsForm = "https://github.com/acme/alpha.git";
		const scpForm = "git@github.com:acme/alpha.git";

		const first = await provider.getCredentials(httpsForm);
		const second = await provider.getCredentials(scpForm);

		trackAskpass(first.env);
		trackAskpass(second.env);

		expect(first.env.GIT_ASKPASS).toBe(second.env.GIT_ASKPASS);
		expect(calls).toEqual([httpsForm]);
	});

	test("expired entry is refetched for the same repo", async () => {
		const calls: string[] = [];
		let nextExpiry = Date.now() - 1;
		const provider = new CloudGitCredentialProvider(async (remoteUrl) => {
			calls.push(remoteUrl);
			return { token: "scoped-token", expiresAt: nextExpiry };
		});

		const repo = "https://github.com/acme/alpha.git";

		const first = await provider.getCredentials(repo);
		nextExpiry = Date.now() + HOUR_MS;
		const second = await provider.getCredentials(repo);

		trackAskpass(first.env);
		trackAskpass(second.env);

		expect(first.env.GIT_ASKPASS).not.toBe(second.env.GIT_ASKPASS);
		expect(calls).toEqual([repo, repo]);
	});

	test("missing remote url returns no askpass and never fetches", async () => {
		let called = false;
		const provider = new CloudGitCredentialProvider(async () => {
			called = true;
			return { token: "scoped-token", expiresAt: Date.now() + HOUR_MS };
		});

		const creds = await provider.getCredentials(null);

		expect(creds.env.GIT_ASKPASS).toBeUndefined();
		expect(creds.env.GIT_TERMINAL_PROMPT).toBe("0");
		expect(called).toBe(false);
	});
});
