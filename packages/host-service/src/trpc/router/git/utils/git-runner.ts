import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { SimpleGit } from "simple-git";
import { workspaces } from "../../../../db/schema";
import { buildRemoteRuntimeResolver } from "../../../../runtime/exec";
import type { WorkspaceRuntime } from "../../../../runtime/seam";
import type { protectedProcedure } from "../../../index";
import { resolveWorktreePath } from "./resolve-worktree";

type RouterCtx = Parameters<
	Parameters<typeof protectedProcedure.query>[0]
>[0]["ctx"];

type WorkspaceRow = NonNullable<
	ReturnType<
		ReturnType<RouterCtx["db"]["query"]["workspaces"]["findFirst"]>["sync"]
	>
>;

/**
 * A git-command executor that works for BOTH a local worktree (via simple-git)
 * and a remote sandbox (via `runtime.exec`). `raw` mirrors `SimpleGit.raw`'s
 * `(args) => Promise<string>` shape so the shared `git-helpers` functions
 * (`resolveBaseComparison`, `buildBranch`, `getChangedFilesForDiff`, …) accept a
 * runner without re-implementation. A failing command rejects, matching
 * simple-git, so existing `.catch(() => "")` guards keep working unchanged.
 */
export interface GitRunner {
	raw(args: string[]): Promise<string>;
	/**
	 * Run a raw shell script (NOT prefixed with `git`) and return stdout + exit
	 * code. Present only on the remote runner, which has an in-sandbox shell; the
	 * local arm uses host node:fs directly and never needs it. Used for the few
	 * status refinements that aren't a single git command (untracked line counts
	 * via `wc`, temp-index rename detection).
	 */
	execShell?(script: string): Promise<{ stdout: string; exitCode: number }>;
}

/** Local runner: simple-git's own `raw`, preserving exact local behavior. */
export function buildLocalGitRunner(git: SimpleGit): GitRunner {
	return { raw: (args) => git.raw(args) };
}

/** Single-quote a shell argument for the remote `runtime.exec` arm. */
function shellQuote(arg: string): string {
	return `'${arg.replaceAll("'", "'\\''")}'`;
}

/**
 * Remote runner: each `raw(args)` becomes `git <args…>` run in-sandbox via
 * `runtime.exec`. Args are individually single-quoted so paths, refs, and
 * format strings with spaces/globs reach git verbatim. A non-zero exit rejects
 * (mirroring simple-git) so callers' `.catch(() => "")` fallbacks behave the
 * same as local. Daytona folds stderr into stdout, so the rejection message
 * carries the combined output.
 */
export function buildRemoteGitRunner(
	runtime: WorkspaceRuntime,
	cwd: string,
): GitRunner {
	if (!runtime.exec) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message:
				"Remote runtime does not support command execution on this host.",
		});
	}
	const exec = runtime.exec.bind(runtime);
	// Empty cwd means "use the runtime's own workdir default" — the Daytona
	// adapter coalesces an undefined cwd to its sandbox-relative repo dir, but
	// treats "" as a literal path, so omit the option entirely when empty.
	const opts = cwd ? { cwd } : undefined;
	return {
		async raw(args) {
			const command = ["git", ...args.map(shellQuote)].join(" ");
			const res = await exec(command, opts);
			if (res.exitCode !== 0) {
				throw new Error(
					`git ${args.join(" ")} exited ${res.exitCode}: ${res.stdout || res.stderr}`,
				);
			}
			return res.stdout;
		},
		async execShell(script) {
			const res = await exec(script, opts);
			return { stdout: res.stdout, exitCode: res.exitCode };
		},
	};
}

export interface ResolvedGitRunner {
	workspace: WorkspaceRow;
	runner: GitRunner;
	/** Sandbox-relative cwd for remote; host worktree path for local. */
	cwd: string;
	/** Live runtime handle; only present on the remote arm. */
	runtime?: WorkspaceRuntime;
}

function findWorkspace(ctx: RouterCtx, workspaceId: string): WorkspaceRow {
	const workspace = ctx.db.query.workspaces
		.findFirst({ where: eq(workspaces.id, workspaceId) })
		.sync();
	if (!workspace) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
	}
	return workspace;
}

/**
 * Resolve a `GitRunner` for a workspace, branching on `runtime_kind`:
 *   - local  → simple-git against the host worktree (byte-for-byte unchanged).
 *   - remote → the live Daytona runtime, running git in-sandbox via `exec`.
 *
 * The Daytona repo is cloned into a sandbox-relative dir (`"workspace"`); the
 * runner leaves `cwd` empty so `runtime.exec` falls back to the runtime's own
 * workdir default rather than guessing the path here.
 */
export async function resolveGitRunner(
	ctx: RouterCtx,
	workspaceId: string,
): Promise<ResolvedGitRunner> {
	const workspace = findWorkspace(ctx, workspaceId);

	if (workspace.runtimeKind === "remote") {
		const resolver = ctx.getRemoteRuntimeResolver
			? await ctx.getRemoteRuntimeResolver()
			: await buildRemoteRuntimeResolver(ctx);
		const runtime = await resolver.resolve(workspaceId);
		return {
			workspace,
			runtime,
			cwd: "",
			runner: buildRemoteGitRunner(runtime, ""),
		};
	}

	const worktreePath = resolveWorktreePath(ctx, workspaceId);
	const git = await ctx.git(worktreePath);
	return {
		workspace,
		cwd: worktreePath,
		runner: buildLocalGitRunner(git),
	};
}
