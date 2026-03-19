import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SandboxState } from "@superset/local-db";
import {
	projects,
	remoteHosts,
	workspaces,
	worktrees,
} from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { eq } from "drizzle-orm";
import { app } from "electron";
import { appState } from "main/lib/app-state";
import { localDb } from "main/lib/local-db";
import { restartDaemon as restartDaemonShared } from "main/lib/terminal";
import {
	TERMINAL_SESSION_KILLED_MESSAGE,
	TerminalKilledError,
} from "main/lib/terminal/errors";
import { getTerminalHostClient } from "main/lib/terminal-host/client";
import type { TerminalRuntime } from "main/lib/workspace-runtime";
import {
	getSshConnectionManager,
	getWorkspaceRuntimeRegistry,
} from "main/lib/workspace-runtime";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { assertWorkspaceUsable } from "../workspaces/utils/usability";
import { getWorkspacePath } from "../workspaces/utils/worktree";
import { resolveTerminalThemeType } from "./theme-type";
import { resolveCwd } from "./utils";

const DEBUG_TERMINAL = process.env.SUPERSET_TERMINAL_DEBUG === "1";
const logger = console;
let createOrAttachCallCounter = 0;

const containerHealthCache = new Map<string, number>(); // containerId → lastVerifiedAt
const HEALTH_CHECK_TTL = 30_000; // 30 seconds

async function writeTaskFile(
	workspacePath: string,
	fileName: string,
	content: string,
): Promise<void> {
	const baseName = path.basename(fileName);
	if (!baseName || baseName !== fileName || fileName.includes("..")) {
		throw new Error(`Invalid task file name: ${fileName}`);
	}

	const dir = path.join(workspacePath, ".superset");
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, baseName), content, { encoding: "utf-8" });
}

const SAFE_ID = z
	.string()
	.min(1)
	.refine(
		(value) =>
			!value.includes("/") && !value.includes("\\") && !value.includes(".."),
		{ message: "Invalid id" },
	);

/**
 * Terminal router using daemon-backed terminal runtime
 * Sessions are keyed by paneId and linked to workspaces for cwd resolution
 *
 * Environment variables set for terminal sessions:
 * - PATH: Prepends ~/.superset/bin so wrapper scripts intercept agent commands
 * - SUPERSET_PANE_ID: The pane ID (used by notification hooks, session key)
 * - SUPERSET_TAB_ID: The tab ID (parent of pane, used by notification hooks)
 * - SUPERSET_WORKSPACE_ID: The workspace ID (used by notification hooks)
 * - SUPERSET_WORKSPACE_NAME: The workspace name (used by setup/teardown scripts)
 * - SUPERSET_WORKSPACE_PATH: The worktree path (used by setup/teardown scripts)
 * - SUPERSET_ROOT_PATH: The main repo path (used by setup/teardown scripts)
 * - SUPERSET_PORT: The hooks server port for agent completion notifications
 */
export const createTerminalRouter = () => {
	const registry = getWorkspaceRuntimeRegistry();
	const terminal = registry.getDefault().terminal;
	if (DEBUG_TERMINAL) {
		console.log(
			"[Terminal Router] Using terminal runtime, capabilities:",
			terminal.capabilities,
		);
	}

	// Track pane → workspace mapping for runtime selection
	const paneWorkspaceMap = new Map<string, string>();

	// Router-level event bridge: stream subscriptions always listen here.
	// createOrAttach wires the actual runtime's events to this bridge so
	// subscriptions that start before createOrAttach still receive data.
	const streamBridge = new EventEmitter();
	streamBridge.setMaxListeners(200);

	// Track cleanup functions for per-pane runtime→bridge forwarding
	const paneForwarders = new Map<string, () => void>();

	// Clean up all forwarders and health cache when the app is about to quit
	// to prevent event listener leaks when the main window closes.
	app.once("before-quit", () => {
		for (const cleanup of paneForwarders.values()) {
			cleanup();
		}
		paneForwarders.clear();
		containerHealthCache.clear();
	});

	function getTerminalForWorkspace(workspaceId: string): TerminalRuntime {
		return registry.getForWorkspaceId(workspaceId).terminal;
	}

	function getTerminalForPane(paneId: string): TerminalRuntime {
		const wsId = paneWorkspaceMap.get(paneId);
		return wsId ? getTerminalForWorkspace(wsId) : terminal;
	}

	/**
	 * Wire a terminal runtime's events for a pane to the stream bridge.
	 * Tears down any previous forwarding for this pane first.
	 */
	function wireRuntimeToBridge(paneId: string, runtime: TerminalRuntime): void {
		// Tear down previous forwarding if any
		const prev = paneForwarders.get(paneId);
		if (prev) prev();

		const dataEvent = `data:${paneId}`;
		const exitEvent = `exit:${paneId}`;
		const disconnectEvent = `disconnect:${paneId}`;
		const errorEvent = `error:${paneId}`;

		const fwdData = (...args: unknown[]) =>
			streamBridge.emit(dataEvent, ...args);
		const fwdExit = (...args: unknown[]) =>
			streamBridge.emit(exitEvent, ...args);
		const fwdDisconnect = (...args: unknown[]) =>
			streamBridge.emit(disconnectEvent, ...args);
		const fwdError = (...args: unknown[]) =>
			streamBridge.emit(errorEvent, ...args);

		runtime.on(dataEvent, fwdData);
		runtime.on(exitEvent, fwdExit);
		runtime.on(disconnectEvent, fwdDisconnect);
		runtime.on(errorEvent, fwdError);

		const cleanup = () => {
			runtime.off(dataEvent, fwdData);
			runtime.off(exitEvent, fwdExit);
			runtime.off(disconnectEvent, fwdDisconnect);
			runtime.off(errorEvent, fwdError);
		};
		paneForwarders.set(paneId, cleanup);
	}

	return router({
		createOrAttach: publicProcedure
			.input(
				z.object({
					paneId: SAFE_ID,
					tabId: z.string(),
					workspaceId: SAFE_ID,
					cols: z.number().optional(),
					rows: z.number().optional(),
					cwd: z.string().optional(),
					skipColdRestore: z.boolean().optional(),
					allowKilled: z.boolean().optional(),
					themeType: z.enum(["dark", "light"]).optional(),
					taskPromptContent: z.string().optional(),
					taskPromptFileName: z.string().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const callId = ++createOrAttachCallCounter;
				const startedAt = Date.now();
				const {
					paneId,
					tabId,
					workspaceId,
					cols,
					rows,
					cwd: cwdOverride,
					skipColdRestore,
					allowKilled,
					themeType,
				} = input;

				paneWorkspaceMap.set(paneId, workspaceId);

				const workspace = localDb
					.select()
					.from(workspaces)
					.where(eq(workspaces.id, workspaceId))
					.get();
				const workspacePath = workspace
					? (getWorkspacePath(workspace) ?? undefined)
					: undefined;
				const isRemote = !!workspace?.remoteHostId;

				if (workspace?.type === "worktree" && !isRemote) {
					assertWorkspaceUsable(workspaceId, workspacePath);
				}
				const cwd = isRemote
					? undefined
					: resolveCwd(cwdOverride, workspacePath);

				if (
					!isRemote &&
					workspacePath &&
					input.taskPromptContent &&
					input.taskPromptFileName
				) {
					await writeTaskFile(
						workspacePath,
						input.taskPromptFileName,
						input.taskPromptContent,
					);
				}

				if (DEBUG_TERMINAL) {
					console.log("[Terminal Router] createOrAttach called:", {
						paneId,
						workspaceId,
						workspacePath,
						cwdOverride,
						resolvedCwd: cwd,
						cols,
						rows,
					});
				}

				const project = workspace
					? localDb
							.select()
							.from(projects)
							.where(eq(projects.id, workspace.projectId))
							.get()
					: undefined;
				const resolvedThemeType = resolveTerminalThemeType({
					requestedThemeType: themeType,
					persistedThemeState: appState.data.themeState,
				});

				// Ensure SSH connection exists for remote workspaces before resolving runtime
				if (isRemote && workspace?.remoteHostId) {
					const sshManager = getSshConnectionManager();
					if (!sshManager.getConnection(workspace.remoteHostId)) {
						const hostConfig = localDb
							.select()
							.from(remoteHosts)
							.where(eq(remoteHosts.id, workspace.remoteHostId))
							.get();
						if (hostConfig) {
							await sshManager.connect({
								id: hostConfig.id,
								hostname: hostConfig.hostname,
								port: hostConfig.port ?? 22,
								username: hostConfig.username,
								authMethod: hostConfig.authMethod as
									| "key"
									| "agent"
									| "password",
								privateKeyPath: hostConfig.privateKeyPath ?? undefined,
							});
						}
					}

					// Check if container still exists and restart if needed
					const client = sshManager.getConnection(workspace.remoteHostId);
					if (client && project?.sandboxState) {
						try {
							const state = JSON.parse(project.sandboxState) as SandboxState;
							if (state.status === "ready" && state.containerId) {
								const { inspectContainer, devcontainerUp } = await import(
									"main/lib/devcontainer/container-manager"
								);
								const lastChecked = containerHealthCache.get(state.containerId);
								if (
									lastChecked &&
									Date.now() - lastChecked < HEALTH_CHECK_TTL
								) {
									// Container was verified healthy recently, skip check
								} else {
									const info = await inspectContainer(
										client,
										state.containerId,
									);
									if (info.status === "running") {
										containerHealthCache.set(state.containerId, Date.now());
									} else if (
										info.status === "not_found" ||
										info.status === "exited"
									) {
										const { getProjectPaths, slugifyName } = await import(
											"main/lib/devcontainer/types"
										);
										const slug = slugifyName(project.name ?? "");
										const paths = getProjectPaths(slug);
										// Ensure devcontainer.json exists (may have been cleaned up)
										const { detectExistingConfig, generateDefaultConfig } =
											await import("main/lib/devcontainer/default-config");
										const effectiveRepoDir =
											project.mainRepoPath ?? paths.repoDir;
										const existingConfig = await detectExistingConfig(
											client,
											effectiveRepoDir,
										);
										if (!existingConfig) {
											await generateDefaultConfig(client, {
												projectName: project.name ?? "project",
												repoDir: effectiveRepoDir,
											});
										}
										const result = await devcontainerUp(
											client,
											{ ...paths, repoDir: effectiveRepoDir },
											project.id,
											{ hasExistingConfig: existingConfig !== null },
										);
										localDb
											.update(projects)
											.set({
												sandboxState: JSON.stringify({
													status: "ready",
													containerId: result.containerId,
													readyAt: Date.now(),
												}),
											})
											.where(eq(projects.id, project.id))
											.run();
										containerHealthCache.set(result.containerId, Date.now());
									} // end if not_found/exited
								} // end TTL cache else
							}
						} catch (err) {
							console.error("[terminal] Container reconciliation failed:", err);
						}
					}
				}

				const terminalRuntime = getTerminalForWorkspace(workspaceId);

				// Wire runtime events to the stream bridge BEFORE creating the session,
				// so any early data from SSH channels is forwarded to waiting subscribers.
				wireRuntimeToBridge(paneId, terminalRuntime);

				try {
					const result = await terminalRuntime.createOrAttach({
						paneId,
						tabId,
						workspaceId,
						workspaceName: workspace?.name,
						workspacePath,
						rootPath: project?.mainRepoPath,
						cwd,
						cols,
						rows,
						skipColdRestore,
						allowKilled,
						themeType: resolvedThemeType,
					});

					if (DEBUG_TERMINAL) {
						console.log("[Terminal Router] createOrAttach result:", {
							callId,
							paneId,
							isNew: result.isNew,
							wasRecovered: result.wasRecovered,
							durationMs: Date.now() - startedAt,
						});
					}

					return {
						paneId,
						isNew: result.isNew,
						scrollback: result.scrollback,
						wasRecovered: result.wasRecovered,
						// Cold restore fields (for reboot recovery)
						isColdRestore: result.isColdRestore,
						previousCwd: result.previousCwd,
						// Include snapshot for daemon mode (renderer can use for rehydration)
						snapshot: result.snapshot,
					};
				} catch (error) {
					const isKilledError =
						error instanceof TerminalKilledError ||
						(error instanceof Error &&
							error.message === TERMINAL_SESSION_KILLED_MESSAGE);
					if (isKilledError) {
						if (DEBUG_TERMINAL) {
							console.warn(
								"[Terminal Router] createOrAttach blocked (killed):",
								{
									paneId,
									workspaceId,
								},
							);
						}
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: TERMINAL_SESSION_KILLED_MESSAGE,
						});
					}
					if (DEBUG_TERMINAL) {
						console.warn("[Terminal Router] createOrAttach failed:", {
							callId,
							paneId,
							durationMs: Date.now() - startedAt,
							error: error instanceof Error ? error.message : String(error),
						});
					}
					console.error("[Terminal Router] createOrAttach ERROR:", error);
					throw error;
				}
			}),

		write: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
					data: z.string(),
					throwOnError: z.boolean().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const shouldThrow = input.throwOnError ?? false;
				const paneTerminal = getTerminalForPane(input.paneId);
				try {
					paneTerminal.write(input);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "Write failed";

					// Emit exit instead of error for deleted sessions to prevent toast floods
					if (message.includes("not found or not alive")) {
						paneTerminal.emit(`exit:${input.paneId}`, 0, 15);
						if (shouldThrow) {
							throw new TRPCError({
								code: "BAD_REQUEST",
								message,
							});
						}
						return;
					}

					paneTerminal.emit(`error:${input.paneId}`, {
						error: message,
						code: "WRITE_FAILED",
					});
					if (shouldThrow) {
						throw new TRPCError({
							code: "INTERNAL_SERVER_ERROR",
							message,
						});
					}
				}
			}),

		ackColdRestore: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(({ input }) => {
				getTerminalForPane(input.paneId).ackColdRestore(input.paneId);
			}),

		resize: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
					cols: z.number(),
					rows: z.number(),
					seq: z.number().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				getTerminalForPane(input.paneId).resize(input);
			}),

		signal: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
					signal: z.string().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				getTerminalForPane(input.paneId).signal(input);
			}),

		kill: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				await getTerminalForPane(input.paneId).kill(input);
				paneWorkspaceMap.delete(input.paneId);
				const cleanupForwarder = paneForwarders.get(input.paneId);
				if (cleanupForwarder) {
					cleanupForwarder();
					paneForwarders.delete(input.paneId);
				}
			}),

		detach: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				getTerminalForPane(input.paneId).detach(input);
			}),

		clearScrollback: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				await getTerminalForPane(input.paneId).clearScrollback(input);
			}),

		listDaemonSessions: publicProcedure.query(async () => {
			const { sessions } = await terminal.management.listSessions();
			return { sessions };
		}),

		killAllDaemonSessions: publicProcedure.mutation(async () => {
			const client = getTerminalHostClient();
			const before = await terminal.management.listSessions();
			const beforeIds = before.sessions.map((s) => s.sessionId);
			console.log(
				"[killAllDaemonSessions] Before kill:",
				beforeIds.length,
				"sessions",
				beforeIds,
			);

			if (beforeIds.length > 0) {
				const results = await Promise.allSettled(
					beforeIds.map((paneId) => terminal.kill({ paneId })),
				);
				for (const [index, result] of results.entries()) {
					if (result.status === "rejected") {
						const paneId = beforeIds[index];
						logger.error(
							`[killAllDaemonSessions] terminal.kill failed for paneId=${paneId}`,
							{
								paneId,
								reason: result.reason,
							},
						);
					}
				}
			}

			// Poll until sessions are actually dead
			const MAX_RETRIES = 10;
			const RETRY_DELAY_MS = 100;
			let remainingCount = before.sessions.length;
			let afterIds: string[] = [];

			for (let i = 0; i < MAX_RETRIES && remainingCount > 0; i++) {
				await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
				const after = await client.listSessions();
				afterIds = after.sessions
					.filter((s) => s.isAlive)
					.map((s) => s.sessionId);
				remainingCount = afterIds.length;

				if (remainingCount > 0) {
					console.log(
						`[killAllDaemonSessions] Retry ${i + 1}/${MAX_RETRIES}: ${remainingCount} sessions still alive`,
						afterIds,
					);
				}
			}

			const killedCount = before.sessions.length - remainingCount;
			console.log(
				"[killAllDaemonSessions] Complete:",
				killedCount,
				"killed,",
				remainingCount,
				"remaining",
				remainingCount > 0 ? afterIds : [],
			);

			return { killedCount, remainingCount };
		}),

		killDaemonSessionsForWorkspace: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.mutation(async ({ input }) => {
				const { sessions } = await terminal.management.listSessions();
				const toKill = sessions.filter(
					(session) => session.workspaceId === input.workspaceId,
				);

				if (toKill.length > 0) {
					const paneIds = toKill.map((session) => session.sessionId);
					const results = await Promise.allSettled(
						paneIds.map((paneId) => terminal.kill({ paneId })),
					);
					for (const [index, result] of results.entries()) {
						if (result.status === "rejected") {
							const paneId = paneIds[index];
							logger.error(
								`[killDaemonSessionsForWorkspace] terminal.kill failed for paneId=${paneId}`,
								{
									paneId,
									workspaceId: input.workspaceId,
									reason: result.reason,
								},
							);
						}
					}
				}

				return { killedCount: toKill.length };
			}),

		clearTerminalHistory: publicProcedure.mutation(async () => {
			await terminal.management.resetHistoryPersistence();
			return { success: true };
		}),

		/** Restart daemon to recover from stuck state. Kills all sessions. */
		restartDaemon: publicProcedure.mutation(async () => {
			return restartDaemonShared();
		}),

		getSession: publicProcedure
			.input(z.string())
			.query(async ({ input: paneId }) => {
				return getTerminalForPane(paneId).getSession(paneId);
			}),

		getWorkspaceCwd: publicProcedure
			.input(z.string())
			.query(({ input: workspaceId }) => {
				const workspace = localDb
					.select()
					.from(workspaces)
					.where(eq(workspaces.id, workspaceId))
					.get();
				if (!workspace) {
					return null;
				}

				if (!workspace.worktreeId) {
					return null;
				}

				const worktree = localDb
					.select()
					.from(worktrees)
					.where(eq(worktrees.id, workspace.worktreeId))
					.get();
				return worktree?.path ?? null;
			}),

		stream: publicProcedure
			.input(z.string())
			.subscription(({ input: paneId }) => {
				return observable<
					| { type: "data"; data: string }
					| {
							type: "exit";
							exitCode: number;
							signal?: number;
							reason?: "killed" | "exited" | "error";
					  }
					| { type: "disconnect"; reason: string }
					| { type: "error"; error: string; code?: string }
				>((emit) => {
					if (DEBUG_TERMINAL) {
						console.log(`[Terminal Stream] Subscribe: ${paneId}`);
					}

					// Listen on the router-level streamBridge instead of directly on a
					// runtime instance. This decouples subscription timing from
					// createOrAttach: the bridge is the stable target, and
					// createOrAttach wires the real runtime → bridge when it runs.
					// For local terminals that may already be wired (e.g., re-attach),
					// ensure the default runtime is wired as a fallback so events
					// aren't missed while waiting for createOrAttach.
					if (!paneForwarders.has(paneId)) {
						wireRuntimeToBridge(paneId, getTerminalForPane(paneId));
					}

					let firstDataReceived = false;

					const onData = (data: string) => {
						if (DEBUG_TERMINAL && !firstDataReceived) {
							firstDataReceived = true;
							console.log(
								`[Terminal Stream] First data for ${paneId}: ${data.length} bytes`,
							);
						}
						emit.next({ type: "data", data });
					};

					const onExit = (
						exitCode: number,
						signal?: number,
						reason?: "killed" | "exited" | "error",
					) => {
						// Don't emit.complete() - paneId is reused across restarts, completion would strand listeners
						emit.next({ type: "exit", exitCode, signal, reason });
					};

					const onDisconnect = (reason: string) => {
						emit.next({ type: "disconnect", reason });
					};

					const onError = (payload: { error: string; code?: string }) => {
						emit.next({
							type: "error",
							error: payload.error,
							code: payload.code,
						});
					};

					streamBridge.on(`data:${paneId}`, onData);
					streamBridge.on(`exit:${paneId}`, onExit);
					streamBridge.on(`disconnect:${paneId}`, onDisconnect);
					streamBridge.on(`error:${paneId}`, onError);

					return () => {
						if (DEBUG_TERMINAL) {
							console.log(`[Terminal Stream] Unsubscribe: ${paneId}`);
						}
						streamBridge.off(`data:${paneId}`, onData);
						streamBridge.off(`exit:${paneId}`, onExit);
						streamBridge.off(`disconnect:${paneId}`, onDisconnect);
						streamBridge.off(`error:${paneId}`, onError);
					};
				});
			}),
	});
};
