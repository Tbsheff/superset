import { eq } from "drizzle-orm";
import type { HostDb } from "../../db/index.ts";
import { workspaces } from "../../db/schema.ts";
import {
	createLocalPtyShellFactory,
	LocalPtyTransport,
	LocalWorktreeAdapter,
} from "../adapters/localWorktree/index.ts";
import type { GitFactory } from "../git/types.ts";
import type { RuntimeAdapter } from "../seam/index.ts";

/** v1 runtime kinds. Phase F adds the remote/Daytona branch. */
export type RuntimeKind = "local";

export interface RuntimeAdapterDeps {
	db: HostDb;
	git: GitFactory;
	eventBus?: import("../../events/index.ts").EventBus;
}

/**
 * The single host-service runtime selector: maps a `runtimeKind` to its
 * adapter. One entry for v1 (local); Phase F appends `"remote"`. This is NOT a
 * second registry — it sits below the host-service capability managers (Phase 0
 * decision) and is the one lookup `workspaces.create`, `workspace-cleanup`, and
 * Phase F share.
 */
export function getRuntimeAdapter(
	runtimeKind: RuntimeKind,
	deps: RuntimeAdapterDeps,
): RuntimeAdapter {
	if (runtimeKind === "local") {
		const transport = new LocalPtyTransport(deps.db, deps.eventBus);
		return new LocalWorktreeAdapter(
			{
				db: deps.db,
				git: deps.git,
				shellFactory: createLocalPtyShellFactory(transport),
			},
			(workspaceId) => {
				const row = deps.db.query.workspaces
					.findFirst({ where: eq(workspaces.id, workspaceId) })
					.sync();
				return row?.worktreePath ?? null;
			},
		);
	}
	throw new Error(`No runtime adapter for kind: ${runtimeKind}`);
}
