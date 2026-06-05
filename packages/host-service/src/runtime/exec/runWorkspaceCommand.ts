import { eq } from "drizzle-orm";
import { workspaces } from "../../db/schema.ts";
import { createTerminalSessionInternal } from "../../terminal/terminal.ts";
import type { HostServiceContext } from "../../types.ts";
import { createDaytonaSdk } from "../adapters/daytona/index.ts";
import {
	getRuntimeAdapter,
	type RuntimeAdapterDeps,
} from "../registry/index.ts";
import type {
	NormalizedRuntimeStatus,
	ShellHandle,
	WorkspaceRuntime,
} from "../seam/index.ts";
import { RuntimeInstanceStore } from "../store/index.ts";

/**
 * Default PTY geometry for a command launched server-side (setup/agent/command
 * at create time). The desktop resizes once it attaches; these are only the
 * dimensions the shell starts with so wrapped output looks sane before attach.
 * Matches the local terminal defaults (`terminal.ts`).
 */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

/**
 * Resolves the LIVE `WorkspaceRuntime` handle for a remote workspace. Kept as a
 * seam so unit tests inject a fake (no Daytona, no network) while production
 * reconnects through the registry adapter. `resolve` throws when the workspace
 * has no live runtime instance (never provisioned, or its sandbox was
 * destroyed) — the caller surfaces that as a command-start failure rather than
 * silently falling back to a local shell that cannot exist.
 */
export interface RemoteRuntimeResolver {
	resolve(workspaceId: string): Promise<WorkspaceRuntime>;
	/**
	 * Reports the live provider status of a workspace's sandbox WITHOUT resuming
	 * it (unlike `resolve`, which starts a stopped sandbox). Read-only: the
	 * renderer polls this to decide whether to show a "waking" state and to
	 * distinguish a fast stopped resume from a slow archived restore. Returns
	 * `{ kind: "destroyed" }` when the workspace has no live runtime instance.
	 */
	status(workspaceId: string): Promise<NormalizedRuntimeStatus>;
}

/**
 * Production `RemoteRuntimeResolver`: looks up the workspace's live
 * `runtime_instances` row, then rebinds a `WorkspaceRuntime` via
 * `adapter.reconnect(externalId)` (which starts a stopped sandbox first). Built
 * the same way as `buildRemoteRuntime` in the create flow — same SDK, store, and
 * scoped-token minter — so create and exec resolve the identical Daytona sandbox.
 *
 * `env` is dynamically imported so loading this module (e.g. for the local path,
 * or a unit test injecting a fake resolver) never triggers `createEnv`'s
 * `process.env` validation; only an actual remote command-start touches it.
 */
export async function buildRemoteRuntimeResolver(
	ctx: HostServiceContext,
): Promise<RemoteRuntimeResolver> {
	const { env } = await import("../../env.ts");
	const store = new RuntimeInstanceStore(ctx.db);
	const deps: RuntimeAdapterDeps = {
		db: ctx.db,
		git: ctx.git,
		eventBus: ctx.eventBus,
		sdk: createDaytonaSdk(env),
		store,
		mintRepoScopedToken: ctx.mintRepoScopedToken,
	};
	return {
		async resolve(workspaceId: string): Promise<WorkspaceRuntime> {
			const record = store.getByWorkspaceId(workspaceId);
			if (!record?.externalId) {
				throw new Error(
					`Remote workspace ${workspaceId} has no live runtime instance to run a command in.`,
				);
			}
			const adapter = getRuntimeAdapter("remote", deps);
			return adapter.reconnect(record.externalId);
		},
		async status(workspaceId: string): Promise<NormalizedRuntimeStatus> {
			const record = store.getByWorkspaceId(workspaceId);
			if (!record?.externalId) return { kind: "destroyed" };
			const adapter = getRuntimeAdapter("remote", deps);
			return adapter.getStatus(record.externalId);
		},
	};
}

export interface RunWorkspaceCommandArgs {
	ctx: HostServiceContext;
	workspaceId: string;
	/** Shell command line to launch. A trailing newline is added if absent. */
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	cols?: number;
	rows?: number;
	/**
	 * Remote runtime resolver. Defaults to `buildRemoteRuntimeResolver(ctx)`.
	 * Tests pass a fake that reconnects to an in-memory sandbox; the local path
	 * never touches it.
	 */
	remoteResolver?: RemoteRuntimeResolver;
}

/**
 * Result of launching a workspace command. The two arms are NOT interchangeable:
 * a local command owns a host-tracked terminal session (`terminalId`, addressed
 * via `/terminal/{id}`), while a remote command runs in a Daytona sandbox PTY
 * the host keeps a live handle to (`shell`) and the desktop later streams via
 * `/runtime/{workspaceId}/pty/{paneId}`.
 */
export type RunWorkspaceCommandResult =
	| { kind: "local"; terminalId: string }
	| { kind: "remote"; externalId: string; shell: ShellHandle }
	| { error: string };

/**
 * Single entry point for launching a setup/agent/command shell in a workspace,
 * routed by `workspaces.runtime_kind`.
 *
 *   - `local`  → `createTerminalSessionInternal` (the existing local daemon PTY),
 *                BYTE-FOR-BYTE the prior behavior. The command rides
 *                `initialCommand`, which the session writes once the shell is up.
 *   - `remote` → resolve the live `DaytonaWorkspaceRuntime`, `startShell` inside
 *                the sandbox, then write the command line. Output streams through
 *                the returned `shell.onData`; the host owns the handle.
 *
 * This is the seam punch-list item "Remote agent/setup execution path": every
 * create-time launcher (setup terminal, agent terminal, command terminal) funnels
 * through here so a command for a remote workspace actually runs in Daytona
 * instead of crashing on the missing local worktree.
 */
export async function runWorkspaceCommand(
	args: RunWorkspaceCommandArgs,
): Promise<RunWorkspaceCommandResult> {
	const { ctx, workspaceId, command } = args;

	const workspace = ctx.db.query.workspaces
		.findFirst({ where: eq(workspaces.id, workspaceId) })
		.sync();
	if (!workspace) {
		return { error: `Workspace not found: ${workspaceId}` };
	}

	if (workspace.runtimeKind !== "remote") {
		const terminalId = crypto.randomUUID();
		const session = await createTerminalSessionInternal({
			terminalId,
			workspaceId,
			db: ctx.db,
			eventBus: ctx.eventBus,
			initialCommand: command,
			...(args.cwd ? { cwd: args.cwd } : {}),
			...(args.cols !== undefined ? { cols: args.cols } : {}),
			...(args.rows !== undefined ? { rows: args.rows } : {}),
		});
		if ("error" in session) return { error: session.error };
		return { kind: "local", terminalId: session.terminalId };
	}

	return runRemoteCommand(args);
}

async function runRemoteCommand(
	args: RunWorkspaceCommandArgs,
): Promise<RunWorkspaceCommandResult> {
	const { ctx, workspaceId, command } = args;
	const resolver =
		args.remoteResolver ?? (await buildRemoteRuntimeResolver(ctx));

	let runtime: WorkspaceRuntime;
	try {
		runtime = await resolver.resolve(workspaceId);
	} catch (error) {
		return { error: describeError(error) };
	}

	let shell: ShellHandle;
	try {
		shell = await runtime.startShell({
			cols: args.cols ?? DEFAULT_COLS,
			rows: args.rows ?? DEFAULT_ROWS,
			...(args.cwd ? { cwd: args.cwd } : {}),
			...(args.env ? { env: args.env } : {}),
		});
	} catch (error) {
		return { error: describeError(error) };
	}

	try {
		// The sandbox PTY buffers stdin until the shell reads it, so writing the
		// command immediately is safe — no OSC-133 readiness gate (mirrors the
		// local `queueInitialCommand`, which also does not gate).
		shell.write(command.endsWith("\n") ? command : `${command}\n`);
	} catch (error) {
		await shell.kill().catch(() => {});
		return { error: describeError(error) };
	}

	return { kind: "remote", externalId: runtime.externalId, shell };
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
