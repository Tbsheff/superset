import { existsSync } from "node:fs";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { workspaces } from "../../../db/schema";
import { buildRemoteRuntimeResolver } from "../../../runtime/exec";
import { resolveRemoteWorkdir } from "../../../runtime/filesystem";
import type { NormalizedRuntimeStatus } from "../../../runtime/seam";
import type { HostServiceContext } from "../../../types";
import { protectedProcedure, router } from "../../index";
import { destroyWorkspace } from "../workspace-cleanup";

/**
 * The live sandbox status the renderer's cold-start gate consumes. A LOCAL
 * (worktree) workspace has no sandbox to wake, so it is always `running`. A
 * remote workspace whose host can't reach the provider surfaces here as the
 * normalized provider status (running / creating / stopped+archived / failed /
 * destroyed).
 */
async function resolveRuntimeResolver(ctx: HostServiceContext) {
	return ctx.getRemoteRuntimeResolver
		? ctx.getRemoteRuntimeResolver()
		: buildRemoteRuntimeResolver(ctx);
}

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
				// the sandbox under the repo-name clone dir, and the Daytona fs API
				// resolves paths relative to the user home, so this is a
				// sandbox-relative dir (not host-absolute). Local stays null — the
				// renderer keeps using `worktreePath`.
				runtimeRoot: isRemote
					? resolveRemoteWorkdir(ctx.db, localWorkspace.id)
					: null,
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

	/**
	 * Live sandbox status for the renderer's cold-start gate. Read-only: it never
	 * resumes a stopped sandbox (that is `resumeRuntime`). Local workspaces report
	 * `running` since they have no sandbox to wake.
	 */
	runtimeStatus: protectedProcedure
		.input(z.object({ id: z.string() }))
		.query(async ({ ctx, input }): Promise<NormalizedRuntimeStatus> => {
			const workspace = ctx.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, input.id) })
				.sync();
			if (!workspace) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Workspace not found",
				});
			}
			if (workspace.runtimeKind !== "remote") return { kind: "running" };
			const resolver = await resolveRuntimeResolver(ctx);
			return resolver.status(input.id);
		}),

	/**
	 * Resumes a stopped/archived sandbox and returns its post-resume status. The
	 * resolve path reconnects through the adapter, which starts the sandbox (with
	 * the state-sized timeout). A mutation (not a query) so it skips the 5s query
	 * timeout — an archived cold-storage restore legitimately takes minutes.
	 */
	resumeRuntime: protectedProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }): Promise<NormalizedRuntimeStatus> => {
			const workspace = ctx.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, input.id) })
				.sync();
			if (!workspace) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Workspace not found",
				});
			}
			if (workspace.runtimeKind !== "remote") return { kind: "running" };
			const resolver = await resolveRuntimeResolver(ctx);
			// resolve() reconnects + starts a stopped/archived sandbox; await it so
			// the returned status reflects the post-resume state.
			await resolver.resolve(input.id);
			return resolver.status(input.id);
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
