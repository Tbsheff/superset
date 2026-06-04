import { exec as nodeExec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { HostDb } from "../../../db/index.ts";
import { LOCAL_WORKTREE_DESCRIPTOR } from "../../descriptors/localWorktree.ts";
import { collectWorkspacePatch } from "../../git/diff-collector/index.ts";
import type { GitFactory } from "../../git/types.ts";
import type {
	ActivityLease,
	CleanupMode,
	ExecOptions,
	ExecResult,
	GetDiffOptions,
	HeartbeatResult,
	NormalizedRuntimeStatus,
	PreviewBinding,
	RuntimeDiff,
	ShellHandle,
	StartShellOptions,
	WorkspaceRuntime,
} from "../../seam/index.ts";

const execAsync = promisify(nodeExec);

/** 64 MiB — large enough that a full `git diff`/`git status` never truncates. */
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;

import type { LocalPtyTransport } from "./LocalPtyTransport.ts";

/**
 * Starts the runtime's execution surface. Injected so the production wiring
 * uses the real PTY (`LocalPtyTransport` → `createTerminalSessionInternal`)
 * while the contract suite can drive a deterministic shell over a real
 * worktree. A factory, not a method, keeps the coordinator from owning shell
 * lifecycle.
 */
export type LocalShellFactory = (args: {
	workspaceId: string;
	worktreePath: string;
	opts: StartShellOptions;
}) => Promise<ShellHandle>;

export interface LocalWorktreeRuntimeArgs {
	workspaceId: string;
	worktreePath: string;
}

export interface LocalWorktreeRuntimeDeps {
	db: HostDb;
	git: GitFactory;
	shellFactory: LocalShellFactory;
}

/**
 * A no-op refresh-activity lease. The local worktree runs on the host network
 * and never idle-stops, so every heartbeat succeeds until release; this matches
 * `LOCAL_WORKTREE_DESCRIPTOR.activity = refresh-activity, idleStopMs = ∞`.
 */
function createNoOpLease(): ActivityLease {
	let released = false;
	return {
		async heartbeat(): Promise<HeartbeatResult> {
			return released ? { ok: false, reason: "expired" } : { ok: true };
		},
		async release(): Promise<void> {
			released = true;
		},
	};
}

/**
 * Builds the production shell factory: every started shell is a real PTY from
 * `LocalPtyTransport`, mapped onto the seam's `ShellHandle`. `StartShellOptions`
 * carry no terminal id (the seam is provider-neutral), so one is minted here.
 */
export function createLocalPtyShellFactory(
	transport: LocalPtyTransport,
): LocalShellFactory {
	return async ({ workspaceId, opts }) => {
		const terminalId = randomUUID();
		const handle = await transport.startShell({
			terminalId,
			workspaceId,
			cwd: opts.cwd,
			cols: opts.cols,
			rows: opts.rows,
			listed: false,
		});
		if ("error" in handle) {
			throw new Error(`local-worktree: failed to start shell: ${handle.error}`);
		}
		return {
			surface: { kind: "pty" },
			write: (data) => handle.write(data),
			resize: (cols, rows) => handle.resize(cols, rows),
			onData: (cb) => handle.onData(cb),
			onExit: (cb) =>
				handle.onExit(({ exitCode, signal }) => cb({ exitCode, signal })),
			kill: async (signal) => {
				await handle.kill(signal as NodeJS.Signals | undefined);
				transport.dispose(terminalId);
			},
		};
	};
}

/**
 * The `WorkspaceRuntime` handle for a local worktree. It COORDINATES the
 * existing concern modules — diffs via the Phase D `collectWorkspacePatch`
 * over `runtime/git`, shells via the injected factory — and owns no new git,
 * filesystem, or teardown logic. `createInstance` binds an existing worktree;
 * it never runs `git worktree add`.
 */
export class LocalWorktreeRuntime implements WorkspaceRuntime {
	readonly role = "workspace" as const;
	readonly descriptor = LOCAL_WORKTREE_DESCRIPTOR;
	readonly workspaceId: string;
	readonly worktreePath: string;

	private readonly deps: LocalWorktreeRuntimeDeps;
	private stopped = false;

	constructor(deps: LocalWorktreeRuntimeDeps, args: LocalWorktreeRuntimeArgs) {
		this.deps = deps;
		this.workspaceId = args.workspaceId;
		this.worktreePath = args.worktreePath;
	}

	/** Reconnect uses the worktree path as the stable external id. */
	get externalId(): string {
		return this.worktreePath;
	}

	async startShell(opts: StartShellOptions): Promise<ShellHandle> {
		return this.deps.shellFactory({
			workspaceId: this.workspaceId,
			worktreePath: this.worktreePath,
			opts,
		});
	}

	async getDiff(opts?: GetDiffOptions): Promise<RuntimeDiff> {
		const git = await this.deps.git(this.worktreePath);
		const patch = await collectWorkspacePatch(git);
		return {
			statusPorcelain: patch.status,
			unifiedPatch: opts?.staged ? patch.staged : patch.unstaged,
		};
	}

	/**
	 * One-shot command run in the worktree via a real shell. A non-zero exit is
	 * returned (with whatever stdout/stderr was captured), never thrown, so the
	 * caller branches on `exitCode` the same way it would for a remote runtime.
	 */
	async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
		try {
			const { stdout, stderr } = await execAsync(command, {
				cwd: opts?.cwd ?? this.worktreePath,
				env: { ...process.env, ...opts?.env },
				maxBuffer: EXEC_MAX_BUFFER,
				...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
			});
			return {
				stdout: stdout.toString(),
				stderr: stderr.toString(),
				exitCode: 0,
			};
		} catch (error) {
			const err = error as {
				code?: number;
				stdout?: string | Buffer;
				stderr?: string | Buffer;
			};
			return {
				stdout: err.stdout?.toString() ?? "",
				stderr: err.stderr?.toString() ?? "",
				exitCode: typeof err.code === "number" ? err.code : 1,
			};
		}
	}

	async exposePreview(port: number): Promise<PreviewBinding> {
		// Local preview is the host network: the renderer reaches a listening
		// port directly on localhost. No tokenized ingress origin is minted.
		return { url: `http://localhost:${port}`, tokenScheme: "none" };
	}

	activityLease(): ActivityLease {
		return createNoOpLease();
	}

	async getStatus(): Promise<NormalizedRuntimeStatus> {
		if (this.stopped) return { kind: "stopped", resumable: true };
		if (!existsSync(this.worktreePath)) return { kind: "destroyed" };
		return { kind: "running" };
	}

	async stop(mode: CleanupMode): Promise<void> {
		// Local stop never tears down the worktree (keep-disk). The destroy saga
		// in trpc/router/workspace-cleanup owns worktree removal in v1; this only
		// marks the handle stopped so getStatus reports a resumable instance.
		if (mode.kind === "delete") {
			this.stopped = true;
			return;
		}
		this.stopped = true;
	}
}
