import { describe, expect, test } from "bun:test";
import type { SimpleGit } from "simple-git";
import type { TokenMinter } from "../../adapters/daytona/types.ts";
import type { WorkspaceRuntime } from "../../seam/index.ts";
import { isRuntimeProviderError } from "../../seam/index.ts";
import type { GitFactory } from "../types.ts";
import type { RepoLookup } from "./assertSameRepoPushTarget.ts";
import {
	type ExportAndPushRemoteArgs,
	exportAndPushRemote,
	type RemotePatchRuntimeResolver,
	type RemoteWorktreeProvider,
} from "./exportAndPushRemote.ts";

const SCOPED_TOKEN = "ghs_scoped_export_push";
const PATCH = Buffer.from(
	`diff --git a/a.txt b/a.txt
new file mode 100644
index 0000000..e69de29
`,
);

interface GitRecorder {
	rawCalls: string[][];
	pushCalls: string[][];
}

function makeGitFactory(rec: GitRecorder): GitFactory {
	const makeGit = (env: Record<string, string>): SimpleGit =>
		({
			raw: async (args: string[]) => {
				rec.rawCalls.push(args);
				return "";
			},
			env: (override: Record<string, string>) =>
				makeGit({ ...env, ...override }),
			push: async (args: string[]) => {
				rec.pushCalls.push(args);
				return { pushed: [] } as unknown as Awaited<
					ReturnType<SimpleGit["push"]>
				>;
			},
		}) as unknown as SimpleGit;
	return (async () => makeGit({})) as unknown as GitFactory;
}

/**
 * Builds a fake `WorkspaceRuntime` whose `exportPatch` returns `patch`, plus the
 * minimum surface the orchestrator touches. `exportPatch: undefined` models a
 * runtime that can't export (e.g. a local runtime resolved by mistake).
 */
function fakeRuntime(opts: {
	patch?: Buffer;
	exportPatch?: () => Promise<Buffer>;
	hasExport?: boolean;
}): WorkspaceRuntime {
	const base = {
		role: "workspace",
		externalId: "sbx-1",
		startShell: async () => {
			throw new Error("not used");
		},
		getDiff: async () => ({ statusPorcelain: "", unifiedPatch: "" }),
		exposePreview: async () => ({ url: "", tokenScheme: "none" as const }),
		activityLease: () => ({
			heartbeat: async () => ({ ok: true as const }),
			release: async () => {},
		}),
		getStatus: async () => "running" as never,
		stop: async () => {},
	} as unknown as WorkspaceRuntime;
	if (opts.hasExport === false) return base;
	return {
		...base,
		exportPatch: opts.exportPatch ?? (async () => opts.patch ?? PATCH),
	};
}

function makeArgs(overrides?: {
	resolver?: RemotePatchRuntimeResolver;
	worktreeProvider?: RemoteWorktreeProvider;
	octokit?: RepoLookup;
	mintRepoScopedToken?: TokenMinter;
}): {
	args: ExportAndPushRemoteArgs;
	rec: GitRecorder;
	acquired: string[];
	released: string[];
	minted: Array<{ owner: string; repo: string }>;
} {
	const rec: GitRecorder = { rawCalls: [], pushCalls: [] };
	const acquired: string[] = [];
	const released: string[] = [];
	const minted: Array<{ owner: string; repo: string }> = [];

	const worktreeProvider: RemoteWorktreeProvider =
		overrides?.worktreeProvider ?? {
			acquire: async () => {
				const worktreePath = "/tmp/remote-wt";
				acquired.push(worktreePath);
				return { worktreePath };
			},
			release: async (worktreePath) => {
				released.push(worktreePath);
			},
		};

	const octokit: RepoLookup = overrides?.octokit ?? {
		repos: {
			get: async () => ({ data: { fork: false, permissions: { push: true } } }),
		},
	};

	const mintRepoScopedToken: TokenMinter =
		overrides?.mintRepoScopedToken ??
		(async ({ owner, repo }) => {
			minted.push({ owner, repo });
			return { token: SCOPED_TOKEN, expiresAt: Date.now() + 3_600_000 };
		});

	const resolver: RemotePatchRuntimeResolver = overrides?.resolver ?? {
		resolve: async () => fakeRuntime({ patch: PATCH }),
	};

	const args: ExportAndPushRemoteArgs = {
		workspaceId: "ws-1",
		branch: "feat/x",
		repo: { owner: "superset", repo: "demo" },
		resolver,
		worktreeProvider,
		push: {
			git: makeGitFactory(rec),
			octokit,
			mintRepoScopedToken,
		},
	};
	return { args, rec, acquired, released, minted };
}

describe("exportAndPushRemote", () => {
	test("exports the runtime patch, applies it in a temp worktree, and pushes", async () => {
		const { args, rec, acquired, released } = makeArgs();
		const result = await exportAndPushRemote(args);

		expect(result).toEqual({
			branch: "feat/x",
			patchKind: "unified-diff",
			pushed: true,
		});
		expect(acquired).toEqual(["/tmp/remote-wt"]);
		expect(released).toEqual(["/tmp/remote-wt"]);
		expect(rec.rawCalls.some((a) => a[0] === "apply")).toBe(true);
		expect(rec.pushCalls).toHaveLength(1);
		expect(rec.pushCalls[0]).toEqual([
			"--set-upstream",
			"origin",
			"HEAD:refs/heads/feat/x",
		]);
	});

	test("acquires the worktree only AFTER exporting the patch", async () => {
		const order: string[] = [];
		const resolver: RemotePatchRuntimeResolver = {
			resolve: async () =>
				fakeRuntime({
					exportPatch: async () => {
						order.push("export");
						return PATCH;
					},
				}),
		};
		const worktreeProvider: RemoteWorktreeProvider = {
			acquire: async () => {
				order.push("acquire");
				return { worktreePath: "/tmp/wt" };
			},
			release: async () => {
				order.push("release");
			},
		};
		const { args } = makeArgs({ resolver, worktreeProvider });
		await exportAndPushRemote(args);
		expect(order).toEqual(["export", "acquire", "release"]);
	});

	test("releases the temp worktree even when the push fails", async () => {
		const released: string[] = [];
		const worktreeProvider: RemoteWorktreeProvider = {
			acquire: async () => ({ worktreePath: "/tmp/wt" }),
			release: async (p) => {
				released.push(p);
			},
		};
		// A fork target makes pushRemotePatch throw CROSS_REPO_PUSH after acquire.
		const octokit: RepoLookup = {
			repos: {
				get: async () => ({
					data: { fork: true, permissions: { push: true } },
				}),
			},
		};
		const { args } = makeArgs({ worktreeProvider, octokit });
		const thrown = await exportAndPushRemote(args).catch((e) => e);
		expect(isRuntimeProviderError(thrown)).toBe(true);
		expect(released).toEqual(["/tmp/wt"]);
	});

	test("throws UNSUPPORTED when the resolved runtime cannot export a patch", async () => {
		const resolver: RemotePatchRuntimeResolver = {
			resolve: async () => fakeRuntime({ hasExport: false }),
		};
		const acquired: string[] = [];
		const worktreeProvider: RemoteWorktreeProvider = {
			acquire: async () => {
				acquired.push("acquire");
				return { worktreePath: "/tmp/wt" };
			},
			release: async () => {},
		};
		const { args } = makeArgs({ resolver, worktreeProvider });
		const thrown = await exportAndPushRemote(args).catch((e) => e);
		expect(isRuntimeProviderError(thrown)).toBe(true);
		if (isRuntimeProviderError(thrown)) {
			expect(thrown.code).toBe("UNSUPPORTED");
		}
		// No worktree is acquired when export is impossible.
		expect(acquired).toEqual([]);
	});

	test("mints the scoped token exactly for the target repo", async () => {
		const { args, minted } = makeArgs();
		await exportAndPushRemote(args);
		expect(minted).toEqual([{ owner: "superset", repo: "demo" }]);
	});

	test("never puts the scoped token in any git argv", async () => {
		const { args, rec } = makeArgs();
		await exportAndPushRemote(args);
		const allArgs = [...rec.rawCalls, ...rec.pushCalls].flat().join(" ");
		expect(allArgs).not.toContain(SCOPED_TOKEN);
	});

	test("propagates a resolver failure without acquiring a worktree", async () => {
		const acquired: string[] = [];
		const resolver: RemotePatchRuntimeResolver = {
			resolve: async () => {
				throw new Error("no live runtime instance");
			},
		};
		const worktreeProvider: RemoteWorktreeProvider = {
			acquire: async () => {
				acquired.push("acquire");
				return { worktreePath: "/tmp/wt" };
			},
			release: async () => {},
		};
		const { args } = makeArgs({ resolver, worktreeProvider });
		await expect(exportAndPushRemote(args)).rejects.toThrow(
			"no live runtime instance",
		);
		expect(acquired).toEqual([]);
	});
});
