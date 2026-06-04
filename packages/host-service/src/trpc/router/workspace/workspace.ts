import { existsSync } from "node:fs";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { workspaces } from "../../../db/schema";
import { REMOTE_SANDBOX_ROOT } from "../../../runtime/filesystem";
import { protectedProcedure, router } from "../../index";
import { destroyWorkspace } from "../workspace-cleanup";

export const workspaceRouter = router({
	get: protectedProcedure
		.input(z.object({ id: z.string() }))
		.query(({ ctx, input }) => {
			const localWorkspace = ctx.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, input.id) })
				.sync();

			if (!localWorkspace) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Workspace not found",
				});
			}

			const isRemote = localWorkspace.runtimeKind === "remote";
			return {
				...localWorkspace,
				worktreeExists: isRemote
					? true
					: existsSync(localWorkspace.worktreePath),
				// Root the renderer's filesystem paths hang off. Remote workspaces
				// have no host worktree (`worktreePath === ""`); their files live in
				// the sandbox under `REMOTE_SANDBOX_ROOT`, and the Daytona fs API
				// resolves paths relative to the user home, so this is a
				// sandbox-relative dir (not host-absolute). Local stays null — the
				// renderer keeps using `worktreePath`.
				runtimeRoot: isRemote ? REMOTE_SANDBOX_ROOT : null,
			};
		}),

	cloudList: protectedProcedure.query(async ({ ctx }) => {
		const rows = await ctx.api.v2Workspace.list.query({
			organizationId: ctx.organizationId,
		});
		return rows.map((row) => ({
			id: row.id,
			projectId: row.projectId,
			branch: row.branch,
			hostId: row.hostId,
		}));
	}),

	gitStatus: protectedProcedure
		.input(z.object({ id: z.string() }))
		.query(async ({ ctx, input }) => {
			const localWorkspace = ctx.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, input.id) })
				.sync();

			if (!localWorkspace) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Workspace not found",
				});
			}

			const git = await ctx.git(localWorkspace.worktreePath);
			const status = await git.status();

			return {
				workspaceId: input.id,
				branch: status.current,
				files: status.files.map((f) => ({
					path: f.path,
					index: f.index,
					workingDir: f.working_dir,
				})),
				isClean: status.isClean(),
			};
		}),

	delete: protectedProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			// Legacy external surface used by CLI/SDK/MCP. Preserve its
			// non-interactive contract while reusing the v2 cleanup path.
			return destroyWorkspace(ctx, {
				workspaceId: input.id,
				deleteBranch: false,
				force: true,
			});
		}),
});
