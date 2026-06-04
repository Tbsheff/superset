import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getSupervisor, waitForDaemonReady } from "../../../daemon";
import { terminalSessions, workspaces } from "../../../db/schema";
import { setRemoteInitialCommand } from "../../../runtime/exec/remote-initial-command-store";
import {
	countTerminalSessions,
	createTerminalSessionInternal,
	disposeSessionAndWait,
	listTerminalSessions,
	parseThemeType,
	writeInputToSession,
} from "../../../terminal/terminal";
import type { HostServiceContext } from "../../../types";
import { protectedProcedure, router } from "../../index";
import { remoteControlRouter } from "./remote-control";

const createSessionInputSchema = z.object({
	workspaceId: z.string(),
	terminalId: z.string().optional(),
	initialCommand: z.string().trim().min(1).optional(),
	cwd: z.string().optional(),
	themeType: z.string().optional(),
	cols: z.number().int().positive().optional(),
	rows: z.number().int().positive().optional(),
});

async function createTerminalSessionFromInput({
	ctx,
	input,
}: {
	ctx: HostServiceContext;
	input: z.infer<typeof createSessionInputSchema>;
}) {
	const terminalId = input.terminalId ?? crypto.randomUUID();

	// Remote (Daytona) workspaces have no local worktree, so there's no daemon
	// PTY to spawn here — their shell is created per pane by the runtime PTY
	// endpoint (`/runtime/:workspaceId/pty/:paneId`) when the renderer's
	// TerminalPane connects. createSession just needs to succeed cheaply and
	// hand back an id the renderer uses as the pane's terminalId. We deliberately
	// do NOT write a terminalSessions row: that table backs the local daemon
	// session map (listSessions/killSession), which a remote pane never touches.
	const workspace = ctx.db.query.workspaces
		.findFirst({ where: eq(workspaces.id, input.workspaceId) })
		.sync();
	if (workspace?.runtimeKind === "remote") {
		// The sandbox shell is created lazily when the pane's `/runtime` socket
		// attaches, so an initial command can't run here — stash it for
		// `RemotePtySession.attach` to write once the shell is up (consumed once).
		if (input.initialCommand) {
			setRemoteInitialCommand(terminalId, input.initialCommand);
		}
		return { terminalId, status: "active" as const };
	}

	const result = await createTerminalSessionInternal({
		terminalId,
		workspaceId: input.workspaceId,
		themeType: parseThemeType(input.themeType),
		db: ctx.db,
		eventBus: ctx.eventBus,
		initialCommand: input.initialCommand,
		cwd: input.cwd,
		cols: input.cols,
		rows: input.rows,
	});

	if ("error" in result) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: result.error,
		});
	}

	return {
		terminalId: result.terminalId,
		status: "active" as const,
	};
}

// Daemon control surface — sibling to the per-workspace terminal ops above.
// Org-scoped (one daemon per host-service); org id comes from request ctx
// rather than env so this module can be imported in tests where env vars
// aren't set.
// Supervisor lives in this same process so calls go through the in-process
// singleton, not over the wire.
const daemonRouter = router({
	getUpdateStatus: protectedProcedure.query(({ ctx }) =>
		getSupervisor().getUpdateStatus(ctx.organizationId),
	),

	listSessions: protectedProcedure.query(async ({ ctx }) => {
		// Wait for the bootstrap so the supervisor has a socket path.
		await waitForDaemonReady(ctx.organizationId);
		return getSupervisor().listSessions(ctx.organizationId);
	}),

	restart: protectedProcedure.mutation(async ({ ctx }) => {
		await waitForDaemonReady(ctx.organizationId);
		return getSupervisor().restart(ctx.organizationId);
	}),

	/**
	 * Phase 2: hand off live PTYs to a successor daemon binary.
	 *
	 * Sessions survive on success — the kernel master fds are inherited by
	 * the new daemon process via stdio. The renderer surfaces this as the
	 * "Update" path (vs `restart` which kills sessions). On failure, the
	 * UI offers force-restart as a fallback.
	 */
	update: protectedProcedure.mutation(async ({ ctx }) => {
		await waitForDaemonReady(ctx.organizationId);
		return getSupervisor().update(ctx.organizationId);
	}),
});

export const terminalRouter = router({
	createSession: protectedProcedure
		.input(createSessionInputSchema)
		.mutation(createTerminalSessionFromInput),

	launchSession: protectedProcedure
		.input(
			createSessionInputSchema.extend({
				initialCommand: z.string().trim().min(1),
			}),
		)
		.mutation(createTerminalSessionFromInput),

	listSessions: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
			}),
		)
		.query(({ input }) => ({
			sessions: listTerminalSessions({
				workspaceId: input.workspaceId,
				includeExited: false,
			}),
		})),

	countBackgroundSessions: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
				attachedTerminalIds: z.array(z.string()).default([]),
			}),
		)
		.query(({ input }) => ({
			count: countTerminalSessions({
				workspaceId: input.workspaceId,
				includeExited: false,
				excludeTerminalIds: input.attachedTerminalIds,
			}),
		})),

	writeInput: protectedProcedure
		.input(
			z.object({
				terminalId: z.string(),
				workspaceId: z.string(),
				data: z.string(),
			}),
		)
		.mutation(({ input }) => {
			const result = writeInputToSession(input);
			if ("error" in result) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: result.error,
				});
			}
			return { success: true as const };
		}),

	killSession: protectedProcedure
		.input(
			z.object({
				terminalId: z.string(),
				workspaceId: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const workspace = ctx.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, input.workspaceId) })
				.sync();

			if (!workspace) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Workspace not found",
				});
			}

			const session = ctx.db.query.terminalSessions
				.findFirst({ where: eq(terminalSessions.id, input.terminalId) })
				.sync();

			if (!session) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Terminal session not found",
				});
			}

			if (session.originWorkspaceId !== input.workspaceId) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Terminal session does not belong to this workspace",
				});
			}

			await disposeSessionAndWait(input.terminalId, ctx.db);
			ctx.terminalAgentStore.markTerminalExited(input.terminalId);
			return { terminalId: input.terminalId, status: "disposed" as const };
		}),

	daemon: daemonRouter,

	remoteControl: remoteControlRouter,
});
