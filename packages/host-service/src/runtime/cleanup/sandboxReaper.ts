import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { runtimeInstances } from "../../db/schema.ts";
import type { HostServiceContext } from "../../types.ts";
import {
	destroyRemoteWorkspace,
	type RemoteWorkspaceDestroyer,
} from "./destroyRemoteWorkspace.ts";

/** Injectable so the unit test reaps without touching Daytona or the network. */
export interface ReapOptions {
	destroyer?: RemoteWorkspaceDestroyer;
}

/**
 * Destroys Daytona sandboxes whose workspace no longer exists in the cloud.
 *
 * Workspace deletion has several client paths (the v2 dashboard delete, the
 * legacy delete, the command palette); only one of them calls the host-service
 * cleanup saga, so the others leak the paid sandbox. The host-service owns the
 * sandbox lifecycle, so it reconciles: any live `runtime_instances` row whose
 * workspace is gone from the cloud is an orphan and gets destroyed.
 *
 * SAFETY: reaping is skipped entirely if the cloud workspace list can't be
 * fetched — a transient cloud/network failure must never be read as "all
 * workspaces deleted" and tear down live sandboxes.
 */
export async function reapOrphanedSandboxes(
	ctx: HostServiceContext,
	opts?: ReapOptions,
): Promise<{ reaped: string[]; errors: string[] }> {
	const live = ctx.db.query.runtimeInstances
		.findMany({
			where: and(
				eq(runtimeInstances.provider, "daytona"),
				isNull(runtimeInstances.destroyedAt),
				isNotNull(runtimeInstances.externalId),
			),
		})
		.sync();
	if (live.length === 0) return { reaped: [], errors: [] };

	let cloudIds: Set<string>;
	try {
		const rows = await ctx.api.v2Workspace.list.query({
			organizationId: ctx.organizationId,
		});
		cloudIds = new Set(rows.map((row) => row.id));
	} catch (error) {
		return {
			reaped: [],
			errors: [
				`cloud workspace list failed; skipping reap: ${
					error instanceof Error ? error.message : String(error)
				}`,
			],
		};
	}

	const reaped: string[] = [];
	const errors: string[] = [];
	for (const instance of live) {
		if (cloudIds.has(instance.workspaceId)) continue;
		const warning = await destroyRemoteWorkspace(
			ctx,
			instance.workspaceId,
			opts?.destroyer,
		);
		if (warning) errors.push(warning);
		else if (instance.externalId) reaped.push(instance.externalId);
	}
	return { reaped, errors };
}

export interface SandboxReaper {
	stop(): void;
}

/**
 * Runs {@link reapOrphanedSandboxes} once at startup and then on an interval.
 * Overlapping runs are prevented; a run that throws is swallowed so the loop
 * survives. `unref()`s the timer so it never keeps the process alive.
 */
export function startSandboxReaper(
	ctxFactory: () => HostServiceContext,
	options?: { intervalMs?: number },
): SandboxReaper {
	const intervalMs = options?.intervalMs ?? 60_000;
	let running = false;
	let stopped = false;

	const tick = async () => {
		if (running || stopped) return;
		running = true;
		try {
			// Built lazily inside the tick: the app-scoped ctx forward-references
			// values still being initialized when createApp wires the reaper up.
			const { reaped, errors } = await reapOrphanedSandboxes(ctxFactory());
			if (reaped.length > 0) {
				console.log(
					`[sandbox-reaper] destroyed ${reaped.length} orphaned sandbox(es)`,
				);
			}
			for (const warning of errors) {
				console.warn("[sandbox-reaper]", warning);
			}
		} catch (error) {
			console.warn(
				"[sandbox-reaper] reap failed:",
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			running = false;
		}
	};

	// Defer the first reap to a later macrotask: `createApp` is still running when
	// the reaper is wired up, and the ctx factory forward-references values it has
	// not finished initializing. The interval covers steady-state reaping.
	const initial = setTimeout(() => void tick(), 2_000);
	initial.unref?.();
	const timer = setInterval(() => void tick(), intervalMs);
	timer.unref?.();

	return {
		stop() {
			stopped = true;
			clearTimeout(initial);
			clearInterval(timer);
		},
	};
}
