import os from "node:os";
import hostServicePackageJson from "@superset/host-service/package.json" with {
	type: "json",
};
import { getHostId, getHostName } from "@superset/shared/host-info";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { workspaces } from "../../../db/schema";
import {
	createDaytonaSdk,
	syncAgentAuthToSandbox,
} from "../../../runtime/adapters/daytona";
import { RuntimeInstanceStore } from "../../../runtime/store";
import type { ApiClient } from "../../../types";
import { protectedProcedure, router } from "../../index";

// Auto-derived from this package's package.json so callers can report exactly
// which bundled host-service build is currently serving requests.
const HOST_SERVICE_VERSION: string = hostServicePackageJson.version;

const ORGANIZATION_CACHE_TTL_MS = 60 * 60 * 1000;

let cachedOrganization: {
	data: { id: string; name: string; slug: string };
	cachedAt: number;
} | null = null;

async function getOrganization(
	api: ApiClient,
	organizationId: string,
): Promise<{ id: string; name: string; slug: string }> {
	if (
		cachedOrganization &&
		cachedOrganization.data.id === organizationId &&
		Date.now() - cachedOrganization.cachedAt < ORGANIZATION_CACHE_TTL_MS
	) {
		return cachedOrganization.data;
	}

	const organization = await api.organization.getByIdFromJwt.query({
		id: organizationId,
	});
	if (!organization) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Organization not found or not accessible from JWT",
		});
	}

	cachedOrganization = { data: organization, cachedAt: Date.now() };
	return organization;
}

export const hostRouter = router({
	info: protectedProcedure.query(async ({ ctx }) => {
		const organization = await getOrganization(ctx.api, ctx.organizationId);

		return {
			hostId: getHostId(),
			hostName: getHostName(),
			version: HOST_SERVICE_VERSION,
			organization,
			platform: os.platform(),
			uptime: process.uptime(),
		};
	}),

	/**
	 * Re-uploads the host user's agent credentials into an already-provisioned
	 * remote (Daytona) workspace so its in-sandbox CLIs re-authenticate without a
	 * full re-provision. Returns only the destination filenames written/skipped —
	 * never credential values. `env` is imported lazily so loading this router on
	 * a local-only host never triggers Daytona env validation.
	 */
	syncAgentAuth: protectedProcedure
		.input(z.object({ workspaceId: z.string() }))
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
			if (workspace.runtimeKind !== "remote") {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Agent auth sync only applies to remote workspaces.",
				});
			}

			const { env } = await import("../../../env");
			const sdk = createDaytonaSdk(env);
			if (!sdk) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Daytona is not configured on this host.",
				});
			}

			const store = new RuntimeInstanceStore(ctx.db);
			const record = store.getByWorkspaceId(input.workspaceId);
			if (!record?.externalId) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Workspace has no live remote runtime to sync into.",
				});
			}

			const sandbox = await sdk.get(record.externalId);
			return syncAgentAuthToSandbox(
				sandbox as unknown as Parameters<typeof syncAgentAuthToSandbox>[0],
			);
		}),
});
