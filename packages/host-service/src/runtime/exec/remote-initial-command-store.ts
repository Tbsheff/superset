/**
 * Process-local store of pending initial commands for remote (Daytona) panes.
 *
 * A remote pane's shell is created lazily when its `/runtime/:ws/pty/:paneId`
 * socket attaches, not at `terminal.createSession` time. So a preset / Run /
 * agent launch that opens a pane WITH a command can't write that command at
 * create time — there is no shell yet. Instead `createSession` records the
 * command here keyed by the pane's `terminalId`, and `RemotePtySession.attach`
 * consumes it (delete-on-read) right after `startShell`.
 *
 * Delete-on-read is the once-only guarantee: the remote endpoint starts a fresh
 * shell on every attach (a bare disconnect leaves the sandbox PTY but discards
 * the host-side session), so without consume-on-read a reconnect would re-run
 * the command. Both writer (tRPC router) and reader (pty endpoint) run in the
 * same host-service process, so a module singleton is the one place this lives.
 */
const pendingInitialCommands = new Map<string, string>();

export function setRemoteInitialCommand(
	terminalId: string,
	command: string,
): void {
	pendingInitialCommands.set(terminalId, command);
}

/** Reads AND removes the pending command so it runs exactly once per launch. */
export function takeRemoteInitialCommand(
	terminalId: string,
): string | undefined {
	const command = pendingInitialCommands.get(terminalId);
	if (command !== undefined) pendingInitialCommands.delete(terminalId);
	return command;
}
