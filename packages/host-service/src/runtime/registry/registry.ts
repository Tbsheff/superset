import { eq } from "drizzle-orm";
import type { HostDb } from "../../db/index.ts";
import { workspaces } from "../../db/schema.ts";
import { DaytonaRuntimeAdapter } from "../adapters/daytona/index.ts";
import type {
	DaytonaInstanceStore,
	DaytonaSdk,
	TokenMinter,
} from "../adapters/daytona/types.ts";
import {
	createLocalPtyShellFactory,
	LocalPtyTransport,
	LocalWorktreeAdapter,
} from "../adapters/localWorktree/index.ts";
import type { GitFactory } from "../git/types.ts";
import { RuntimeProviderError } from "../seam/index.ts";
import type { RuntimeAdapter } from "../seam/index.ts";

/** v1 runtime kinds: `local` worktrees and `remote` Daytona sandboxes. */
export type RuntimeKind = "local" | "remote";

export interface RuntimeAdapterDeps {
	db: HostDb;
	git: GitFactory;
	eventBus?: import("../../events/index.ts").EventBus;
	/**
	 * Remote (Daytona) dependencies. All three are required to build the remote
	 * adapter; any of them being absent means the host is not configured for
	 * remote runtimes (no Daytona credentials, no production store, or no scoped
	 * token minter), and `getRuntimeAdapter("remote", …)` throws CONFIG_MISSING.
	 * They are optional here so a local-only host can call `getRuntimeAdapter`
	 * without constructing any Daytona wiring.
	 */
	sdk?: DaytonaSdk | undefined;
	store?: DaytonaInstanceStore | undefined;
	mintRepoScopedToken?: TokenMinter | undefined;
}

/**
 * The single host-service runtime selector: maps a `runtimeKind` to its
 * adapter. Two entries for v1 — `local` worktrees and `remote` Daytona
 * sandboxes. This is NOT a second registry — it sits below the host-service
 * capability managers (Phase 0 decision) and is the one lookup
 * `workspaces.create`, `workspace-cleanup`, and the remote flows share.
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
	if (runtimeKind === "remote") {
		const { sdk, store, mintRepoScopedToken } = deps;
		if (!sdk || !store || !mintRepoScopedToken) {
			throw new RuntimeProviderError(
				"CONFIG_MISSING",
				"Daytona is not configured; cannot create a remote runtime. " +
					"Set DAYTONA_API_KEY (or DAYTONA_JWT_TOKEN + DAYTONA_ORGANIZATION_ID) " +
					"and wire the runtime store + scoped-token minter.",
			);
		}
		return new DaytonaRuntimeAdapter({
			sdk,
			store,
			git: deps.git,
			mintRepoScopedToken,
		});
	}
	throw new Error(`No runtime adapter for kind: ${runtimeKind satisfies never}`);
}
