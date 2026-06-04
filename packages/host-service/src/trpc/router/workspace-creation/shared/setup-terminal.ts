import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { projects, workspaces } from "../../../../db/schema";
import type { RemoteRuntimeResolver } from "../../../../runtime/exec";
import { runWorkspaceCommand } from "../../../../runtime/exec";
import {
	getResolvedSetupCommands,
	loadSetupConfig,
} from "../../../../runtime/setup/config";
import type { HostServiceContext } from "../../../../types";
import type { TerminalDescriptor } from "./types";

interface StartSetupTerminalArgs {
	ctx: HostServiceContext;
	workspaceId: string;
	/** Injected by tests so the remote path never touches Daytona. */
	remoteResolver?: RemoteRuntimeResolver;
}

interface StartSetupTerminalResult {
	terminal: TerminalDescriptor | null;
	warning: string | null;
}

/**
 * Resolve and start the workspace-creation setup terminal, if any.
 *
 * Source order:
 *   1. Configured `setup` array from `.superset/config.json` (+ user override
 *      and `config.local.json` overlay) — joined with ` && ` so failures
 *      short-circuit.
 *   2. Fallback: `bash <repoPath>/.superset/setup.sh` against the main repo
 *      (NOT the worktree — worktrees skip gitignored files, the main repo is
 *      authoritative). Scripts that need the canonical `.superset/` dir read
 *      `$SUPERSET_ROOT_PATH`, injected by the v2 terminal env builder.
 *
 * No-op when neither source resolves to anything runnable.
 */
export async function startSetupTerminalIfPresent(
	args: StartSetupTerminalArgs,
): Promise<StartSetupTerminalResult> {
	const row = args.ctx.db
		.select({
			worktreePath: workspaces.worktreePath,
			runtimeKind: workspaces.runtimeKind,
			repoPath: projects.repoPath,
			projectId: workspaces.projectId,
		})
		.from(workspaces)
		.innerJoin(projects, eq(projects.id, workspaces.projectId))
		.where(eq(workspaces.id, args.workspaceId))
		.get();

	// A remote workspace has no local worktree (sentinel empty path), so the
	// worktreePath gate only applies to local runtimes. Both still need a
	// repoPath to resolve the project's setup config.
	if (!row || !row.repoPath) {
		return { terminal: null, warning: null };
	}
	const isRemote = row.runtimeKind === "remote";
	if (!isRemote && !row.worktreePath) {
		return { terminal: null, warning: null };
	}

	const initialCommand = resolveInitialCommand({
		repoPath: row.repoPath,
		projectId: row.projectId,
		// Remote setup runs inside the sandbox at the cloned repo root, so the
		// `setup.sh` fallback must be sandbox-relative, not a host absolute path.
		fallbackScriptStyle: isRemote ? "relative" : "absolute",
	});
	if (!initialCommand) {
		return { terminal: null, warning: null };
	}

	const result = await runWorkspaceCommand({
		ctx: args.ctx,
		workspaceId: args.workspaceId,
		command: initialCommand,
		...(args.remoteResolver ? { remoteResolver: args.remoteResolver } : {}),
	});
	if ("error" in result) {
		return {
			terminal: null,
			warning: `Failed to start setup terminal: ${result.error}`,
		};
	}

	// Only the local path owns a host-tracked terminal id the UI can attach to.
	// Remote setup runs in the sandbox PTY; its descriptor is reported without a
	// terminal id (the desktop streams remote panes separately).
	const id = result.kind === "local" ? result.terminalId : args.workspaceId;
	return {
		terminal: {
			id,
			role: "setup",
			label: "Workspace Setup",
		},
		warning: null,
	};
}

/** Exported for tests. Resolves the initial command for the setup terminal. */
export function resolveInitialCommand(args: {
	repoPath: string;
	projectId: string;
	/** Override $HOME for tests. */
	homeDir?: string;
	/**
	 * How to address the `.superset/setup.sh` fallback. `absolute` (default) uses
	 * the host repo path for the local daemon; `relative` uses the sandbox-cloned
	 * `.superset/setup.sh` for a remote runtime whose cwd is the repo root.
	 */
	fallbackScriptStyle?: "absolute" | "relative";
}): string | null {
	const config = loadSetupConfig(args);
	const commands = getResolvedSetupCommands(config);
	if (commands.length > 0) {
		return commands.join(" && ");
	}

	if ((args.fallbackScriptStyle ?? "absolute") === "relative") {
		// The repo is cloned into the sandbox; the host can confirm the script is
		// committed by checking its own copy, but the command itself stays
		// sandbox-relative so it resolves against the runtime's working directory.
		const hostCopy = join(args.repoPath, ".superset", "setup.sh");
		return existsSync(hostCopy) ? "bash .superset/setup.sh" : null;
	}

	const fallbackScript = join(args.repoPath, ".superset", "setup.sh");
	if (existsSync(fallbackScript)) {
		return `bash ${singleQuote(fallbackScript)}`;
	}

	return null;
}

/** POSIX single-quote escape: safe for any path passed through a shell. */
function singleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
