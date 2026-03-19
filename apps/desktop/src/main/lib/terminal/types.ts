export type TerminalExitReason = "killed" | "exited" | "error";

export interface TerminalDataEvent {
	type: "data";
	data: string;
}

export interface TerminalExitEvent {
	type: "exit";
	exitCode: number;
	signal?: number;
	reason?: TerminalExitReason;
}

export type TerminalEvent = TerminalDataEvent | TerminalExitEvent;

export interface SessionResult {
	isNew: boolean;
	/**
	 * Initial terminal content (ANSI).
	 * In daemon mode, this is empty - prefer `snapshot.snapshotAnsi` when available.
	 * In non-daemon mode, this contains the recovered scrollback content.
	 */
	scrollback: string;
	wasRecovered: boolean;
	/**
	 * True if this is a cold restore from disk after reboot/crash.
	 * The daemon didn't have this session, but we found scrollback on disk
	 * with an unclean shutdown (meta.json has no endedAt).
	 * UI should show "Session Restored" banner and "Start Shell" action.
	 */
	isColdRestore?: boolean;
	/**
	 * The cwd from the previous session (for cold restore).
	 * Use this to start the new shell in the same directory.
	 */
	previousCwd?: string;
	/** Snapshot from daemon (if using daemon mode) */
	snapshot?: {
		snapshotAnsi: string;
		rehydrateSequences: string;
		cwd: string | null;
		modes: Record<string, boolean>;
		cols: number;
		rows: number;
		scrollbackLines: number;
		/** Debug diagnostics for troubleshooting */
		debug?: {
			xtermBufferType: string;
			hasAltScreenEntry: boolean;
			altBuffer?: {
				lines: number;
				nonEmptyLines: number;
				totalChars: number;
				cursorX: number;
				cursorY: number;
				sampleLines: string[];
			};
			normalBufferLines: number;
		};
	};
}

export interface CreateSessionParams {
	paneId: string;
	tabId: string;
	workspaceId: string;
	workspaceName?: string;
	workspacePath?: string;
	rootPath?: string;
	cwd?: string;
	cols?: number;
	rows?: number;
	/** Skip cold restore detection (used when auto-resuming after cold restore) */
	skipColdRestore?: boolean;
	/** Allow restarting a session that was explicitly killed */
	allowKilled?: boolean;
	themeType?: "dark" | "light";
}
