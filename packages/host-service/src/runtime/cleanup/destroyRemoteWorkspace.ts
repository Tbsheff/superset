import type { HostServiceContext } from "../../types.ts";
import { createDaytonaSdk } from "../adapters/daytona/index.ts";
import {
	getRuntimeAdapter,
	type RuntimeAdapterDeps,
} from "../registry/index.ts";
import { RuntimeInstanceStore } from "../store/index.ts";

/**
 * Outcome of attempting to destroy a remote workspace's runtime. `destroyed`
 * means a live sandbox was deleted (or the destroy was idempotently a no-op);
 * `no-runtime` means there was nothing to destroy (already torn down, or never
 * provisioned); `error` carries a human message the caller surfaces as a delete
 * warning rather than failing the whole destroy saga.
 */
export type RemoteDestroyOutcome =
	| { kind: "destroyed"; externalId: string }
	| { kind: "no-runtime" }
	| { kind: "error"; message: string };

/**
 * Resolves a remote workspace's live runtime instance and tears down the
 * underlying Daytona sandbox. Kept as an injectable seam so the cleanup router
 * unit test can drive it with a fake adapter (no Daytona, no network) while
 * production reaches the registry-built `DaytonaRuntimeAdapter`.
 */
export interface RemoteWorkspaceDestroyer {
	destroy(workspaceId: string): Promise<RemoteDestroyOutcome>;
}

/**
 * Production `RemoteWorkspaceDestroyer`. Reads the workspace's newest live
 * `runtime_instances` row, builds the Daytona adapter the same way the create /
 * exec flows do (SDK + store + scoped-token minter), and calls
 * `adapter.destroy(externalId, { kind: "delete" })` — which releases the
 * keep-alive lease + any PTY, deletes the sandbox, and `markDestroyed`s the row.
 *
 * `env` is dynamically imported so loading this module on a local-only host (or
 * for the local delete path) never triggers `createEnv`'s `process.env`
 * validation; only an actual remote delete touches it.
 */
export async function buildRemoteWorkspaceDestroyer(
	ctx: HostServiceContext,
): Promise<RemoteWorkspaceDestroyer> {
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
		async destroy(workspaceId: string): Promise<RemoteDestroyOutcome> {
			const record = store.getByWorkspaceId(workspaceId);
			if (!record?.externalId) return { kind: "no-runtime" };
			try {
				const adapter = getRuntimeAdapter("remote", deps);
				await adapter.destroy(record.externalId, { kind: "delete" });
				return { kind: "destroyed", externalId: record.externalId };
			} catch (error) {
				return {
					kind: "error",
					message: error instanceof Error ? error.message : String(error),
				};
			}
		},
	};
}

/**
 * Convenience wrapper the cleanup router calls: destroys the remote runtime via
 * the provided destroyer (or the production builder when omitted), translating
 * the outcome into a warning string the saga collects. Returns `undefined` on
 * success / nothing-to-do; a message string when destroy reported an error.
 */
export async function destroyRemoteWorkspace(
	ctx: HostServiceContext,
	workspaceId: string,
	destroyer?: RemoteWorkspaceDestroyer,
): Promise<string | undefined> {
	let resolved: RemoteWorkspaceDestroyer;
	try {
		resolved = destroyer ?? (await buildRemoteWorkspaceDestroyer(ctx));
	} catch (error) {
		return `Failed to build remote runtime destroyer: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}
	const outcome = await resolved.destroy(workspaceId);
	if (outcome.kind === "error") {
		return `Failed to destroy remote sandbox: ${outcome.message}`;
	}
	return undefined;
}
