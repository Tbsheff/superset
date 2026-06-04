import { describe, expect, test } from "bun:test";
import type { SimpleGit } from "simple-git";
import type { TokenMinter } from "../../adapters/daytona/types.ts";
import { isRuntimeProviderError } from "../../seam/index.ts";
import type { GitFactory } from "../types.ts";
import type { RepoLookup } from "./assertSameRepoPushTarget.ts";
import {
	type PushRemotePatchDeps,
	pushRemotePatch,
} from "./pushRemotePatch.ts";

const SCOPED_TOKEN = "ghs_scoped_push_secret";
const PATCH = Buffer.from(
	`diff --git a/a.txt b/a.txt
new file mode 100644
index 0000000..e69de29
`,
);

interface FakeGitRecorder {
	rawCalls: string[][];
	pushCalls: string[][];
	envOverrides: Array<Record<string, string>>;
}

function makeGitFactory(rec: FakeGitRecorder): GitFactory {
	const makeGit = (env: Record<string, string>): SimpleGit =>
		({
			raw: async (args: string[]) => {
				rec.rawCalls.push(args);
				return "";
			},
			env: (override: Record<string, string>) => {
				rec.envOverrides.push(override);
				return makeGit({ ...env, ...override });
			},
			push: async (args: string[]) => {
				rec.pushCalls.push(args);
				return { pushed: [] } as unknown as Awaited<
					ReturnType<SimpleGit["push"]>
				>;
			},
		}) as unknown as SimpleGit;
	return (async () => makeGit({})) as unknown as GitFactory;
}

function makeDeps(overrides?: Partial<PushRemotePatchDeps>): {
	deps: PushRemotePatchDeps;
	rec: FakeGitRecorder;
	order: string[];
	minted: Array<{ owner: string; repo: string }>;
} {
	const rec: FakeGitRecorder = {
		rawCalls: [],
		pushCalls: [],
		envOverrides: [],
	};
	const order: string[] = [];
	const minted: Array<{ owner: string; repo: string }> = [];
	const octokit: RepoLookup = {
		repos: {
			get: async () => {
				order.push("guard");
				return { data: { fork: false, permissions: { push: true } } };
			},
		},
	};
	const mintRepoScopedToken: TokenMinter = async ({ owner, repo }) => {
		order.push("mint");
		minted.push({ owner, repo });
		return { token: SCOPED_TOKEN, expiresAt: Date.now() + 3_600_000 };
	};
	const deps: PushRemotePatchDeps = {
		git: makeGitFactory(rec),
		octokit,
		mintRepoScopedToken,
		...overrides,
	};
	return { deps, rec, order, minted };
}

const input = {
	worktreePath: "/tmp/ws",
	branch: "feat/x",
	repo: { owner: "superset", repo: "demo" },
	patch: PATCH,
};

describe("pushRemotePatch", () => {
	test("applies the patch then pushes the branch to origin", async () => {
		const { deps, rec } = makeDeps();
		const result = await pushRemotePatch(deps, input);
		expect(result).toEqual({
			branch: "feat/x",
			patchKind: "unified-diff",
			pushed: true,
		});
		expect(rec.rawCalls.some((a) => a[0] === "apply")).toBe(true);
		expect(rec.pushCalls).toHaveLength(1);
		expect(rec.pushCalls[0]).toEqual([
			"--set-upstream",
			"origin",
			"HEAD:refs/heads/feat/x",
		]);
	});

	test("guards the push target BEFORE minting a token", async () => {
		const { deps, order } = makeDeps();
		await pushRemotePatch(deps, input);
		expect(order).toEqual(["guard", "mint"]);
	});

	test("mints the token scoped to exactly the target repo", async () => {
		const { deps, minted } = makeDeps();
		await pushRemotePatch(deps, input);
		expect(minted).toEqual([{ owner: "superset", repo: "demo" }]);
	});

	test("passes the token via askpass env, never in the push args or a URL", async () => {
		const { deps, rec } = makeDeps();
		await pushRemotePatch(deps, input);
		// Token never appears in any git argv.
		const allArgs = [...rec.rawCalls, ...rec.pushCalls].flat().join(" ");
		expect(allArgs).not.toContain(SCOPED_TOKEN);
		// Push runs through a GIT_ASKPASS env override.
		const askpassOverride = rec.envOverrides.find((e) => e.GIT_ASKPASS);
		expect(askpassOverride?.GIT_ASKPASS).toMatch(/git-askpass-.*\.sh$/);
		expect(askpassOverride?.GIT_TERMINAL_PROMPT).toBe("0");
	});

	test("does not mint or push when the guard rejects (fork)", async () => {
		const order: string[] = [];
		const minted: Array<{ owner: string; repo: string }> = [];
		const { deps, rec } = makeDeps({
			octokit: {
				repos: {
					get: async () => {
						order.push("guard");
						return { data: { fork: true, permissions: { push: true } } };
					},
				},
			},
			mintRepoScopedToken: async ({ owner, repo }) => {
				minted.push({ owner, repo });
				return { token: SCOPED_TOKEN, expiresAt: Date.now() + 1000 };
			},
		});
		const thrown = await pushRemotePatch(deps, input).catch((e) => e);
		expect(isRuntimeProviderError(thrown)).toBe(true);
		if (isRuntimeProviderError(thrown)) {
			expect(thrown.code).toBe("CROSS_REPO_PUSH");
		}
		expect(minted).toHaveLength(0);
		expect(rec.pushCalls).toHaveLength(0);
	});

	test("refuses an empty patch before guarding or minting", async () => {
		const { deps, order, rec } = makeDeps();
		const thrown = await pushRemotePatch(deps, {
			...input,
			patch: Buffer.alloc(0),
		}).catch((e) => e);
		expect(isRuntimeProviderError(thrown)).toBe(true);
		expect(order).toEqual([]);
		expect(rec.pushCalls).toHaveLength(0);
	});

	test("refuses a detached HEAD (empty branch)", async () => {
		const { deps } = makeDeps();
		const thrown = await pushRemotePatch(deps, {
			...input,
			branch: "HEAD",
		}).catch((e) => e);
		expect(isRuntimeProviderError(thrown)).toBe(true);
	});
});
