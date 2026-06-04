import type { RemoteRuntimeResolver } from "../../../../runtime/exec";
import { runWorkspaceCommand } from "../../../../runtime/exec";
import type { HostServiceContext } from "../../../../types";
import type { TerminalDescriptor } from "./types";

interface StartCommandTerminalArgs {
	ctx: HostServiceContext;
	workspaceId: string;
	command: string;
	/** Injected by tests so the remote path never touches Daytona. */
	remoteResolver?: RemoteRuntimeResolver;
}

interface StartCommandTerminalResult {
	terminal: TerminalDescriptor | null;
	warning: string | null;
}

/**
 * Start a terminal session that runs an arbitrary command in the workspace,
 * routed by runtime kind: a local worktree PTY or, for remote workspaces, the
 * Daytona sandbox PTY. Mirrors the setup terminal, but the command is supplied
 * by the caller (the CLI `--command` flag) instead of resolved from config.
 */
export async function startCommandTerminal(
	args: StartCommandTerminalArgs,
): Promise<StartCommandTerminalResult> {
	const result = await runWorkspaceCommand({
		ctx: args.ctx,
		workspaceId: args.workspaceId,
		command: args.command,
		...(args.remoteResolver ? { remoteResolver: args.remoteResolver } : {}),
	});
	if ("error" in result) {
		return {
			terminal: null,
			warning: `Failed to start command terminal: ${result.error}`,
		};
	}

	// Only the local path owns a host-tracked terminal id; remote runs in the
	// sandbox PTY and is streamed by the desktop separately.
	const id = result.kind === "local" ? result.terminalId : args.workspaceId;
	return {
		terminal: { id, role: "command", label: "Command" },
		warning: null,
	};
}
