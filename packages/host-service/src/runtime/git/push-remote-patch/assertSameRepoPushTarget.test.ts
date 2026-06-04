import { describe, expect, test } from "bun:test";
import { isRuntimeProviderError } from "../../seam/index.ts";
import {
	assertSameRepoPushTarget,
	type RepoLookup,
} from "./assertSameRepoPushTarget.ts";

function makeOctokit(
	data: { fork: boolean; permissions?: { push?: boolean } | null },
	calls?: Array<{ owner: string; repo: string }>,
): RepoLookup {
	return {
		repos: {
			get: async (args: { owner: string; repo: string }) => {
				calls?.push(args);
				return { data };
			},
		},
	};
}

const COORDS = { owner: "superset", repo: "demo" };

async function capture(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		await fn();
		return undefined;
	} catch (error) {
		return error;
	}
}

describe("assertSameRepoPushTarget", () => {
	test("allows a non-fork repo the caller can push to", async () => {
		const calls: Array<{ owner: string; repo: string }> = [];
		const octokit = makeOctokit(
			{ fork: false, permissions: { push: true } },
			calls,
		);
		await assertSameRepoPushTarget(octokit, COORDS);
		expect(calls).toEqual([COORDS]);
	});

	test("rejects a fork with CROSS_REPO_PUSH", async () => {
		const octokit = makeOctokit({ fork: true, permissions: { push: true } });
		const thrown = await capture(() =>
			assertSameRepoPushTarget(octokit, COORDS),
		);
		expect(isRuntimeProviderError(thrown)).toBe(true);
		if (isRuntimeProviderError(thrown)) {
			expect(thrown.code).toBe("CROSS_REPO_PUSH");
			expect(thrown.message).toContain("fork");
		}
	});

	test("rejects when the caller lacks push permission", async () => {
		const octokit = makeOctokit({ fork: false, permissions: { push: false } });
		const thrown = await capture(() =>
			assertSameRepoPushTarget(octokit, COORDS),
		);
		expect(isRuntimeProviderError(thrown)).toBe(true);
		if (isRuntimeProviderError(thrown)) {
			expect(thrown.code).toBe("CROSS_REPO_PUSH");
		}
	});

	test("rejects when permissions are absent (unknown write access)", async () => {
		const octokit = makeOctokit({ fork: false, permissions: null });
		const thrown = await capture(() =>
			assertSameRepoPushTarget(octokit, COORDS),
		);
		expect(isRuntimeProviderError(thrown)).toBe(true);
	});

	test("maps a repo-lookup failure to CROSS_REPO_PUSH", async () => {
		const octokit: RepoLookup = {
			repos: {
				get: async () => {
					throw new Error("404 not found");
				},
			},
		};
		const thrown = await capture(() =>
			assertSameRepoPushTarget(octokit, COORDS),
		);
		expect(isRuntimeProviderError(thrown)).toBe(true);
		if (isRuntimeProviderError(thrown)) {
			expect(thrown.code).toBe("CROSS_REPO_PUSH");
		}
	});
});
