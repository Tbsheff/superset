import { observable } from "@trpc/server/observable";
import {
	getMachines,
	globalSandboxEmitter,
	type SandboxStateChange,
} from "main/lib/devcontainer/state-machine";
import { z } from "zod";
import { publicProcedure, router } from "../../..";

export const createSandboxProcedures = () => {
	return router({
		onSandboxStateChange: publicProcedure
			.input(
				z.object({ projectIds: z.array(z.string()).optional() }).optional(),
			)
			.subscription(({ input }) => {
				return observable<SandboxStateChange>((emit) => {
					const handler = (change: SandboxStateChange) => {
						if (
							input?.projectIds &&
							!input.projectIds.includes(change.projectId)
						) {
							return;
						}
						emit.next(change);
					};

					// Emit current state for all matching machines immediately to
					// avoid a race condition where state changed before subscription.
					for (const [projectId, machine] of getMachines()) {
						if (!input?.projectIds || input.projectIds.includes(projectId)) {
							emit.next({ projectId, state: machine.getState() });
						}
					}

					globalSandboxEmitter.on("state", handler);

					return () => {
						globalSandboxEmitter.off("state", handler);
					};
				});
			}),
	});
};
