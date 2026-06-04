import {
	setWorkspaceLocal,
	setWorkspaceRemote,
} from "main/lib/workspace-runtime";
import { z } from "zod";
import { publicProcedure, router } from "../../..";

/**
 * The desktop-main binding store is the synchronous mirror of the host-service
 * `workspaces.runtime_kind` column (the resolver runs inside the registry's
 * `getForWorkspaceId`, so it can't hit the network). The renderer is the only
 * process that talks to the host-service tRPC, so it learns a workspace's
 * `runtimeKind` (and the organizationId whose host-service hosts its sandbox)
 * and pushes it here. Until this runs, the registry routes every workspace to
 * the local runtime.
 */
const runtimeBindingInput = z
	.object({
		workspaceId: z.string().min(1),
		runtimeKind: z.enum(["local", "remote"]),
		organizationId: z.string().min(1).optional(),
	})
	.refine((value) => value.runtimeKind !== "remote" || !!value.organizationId, {
		message: "organizationId is required for a remote binding",
	});

/**
 * Records a workspace's runtime binding in the main-process store. A remote
 * binding requires the organizationId so the transport factory can resolve the
 * host-service connection; a local binding clears any prior remote binding.
 * Returns void — the store is fire-and-forget from the renderer's view.
 */
export function applyRuntimeBinding(
	input: z.infer<typeof runtimeBindingInput>,
): void {
	if (input.runtimeKind === "remote") {
		// The refine above guarantees organizationId is present here.
		setWorkspaceRemote(input.workspaceId, input.organizationId as string);
		return;
	}
	setWorkspaceLocal(input.workspaceId);
}

export const createRuntimeBindingProcedures = () => {
	return router({
		setRuntimeBinding: publicProcedure
			.input(runtimeBindingInput)
			.mutation(({ input }) => {
				applyRuntimeBinding(input);
				return { ok: true as const };
			}),
	});
};
