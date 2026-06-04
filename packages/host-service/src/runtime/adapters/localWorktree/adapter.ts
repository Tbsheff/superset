import { existsSync } from "node:fs";
import { LOCAL_WORKTREE_DESCRIPTOR } from "../../descriptors/localWorktree.ts";
import type {
	CleanupMode,
	NormalizedRuntimeStatus,
	RuntimeAdapter,
	RuntimeHandleFor,
	RuntimePlan,
	RuntimeRole,
} from "../../seam/index.ts";
import {
	LocalWorktreeRuntime,
	type LocalWorktreeRuntimeDeps,
} from "./LocalWorktreeRuntime.ts";

/**
 * Resolves the existing worktree path for a workspace. The seam's `RuntimePlan`
 * is provider-neutral and carries no worktree path (that is a local-only
 * concept), so the adapter resolves it here — from the host DB in production,
 * from an in-memory map in the contract harness. Returning null means "no
 * worktree bound", which surfaces as a clear error rather than a fresh clone.
 */
export type WorktreeResolver = (workspaceId: string) => string | null;

export class LocalWorktreeAdapter implements RuntimeAdapter {
	readonly descriptor = LOCAL_WORKTREE_DESCRIPTOR;

	private readonly deps: LocalWorktreeRuntimeDeps;
	private readonly resolveWorktree: WorktreeResolver;
	private readonly instances = new Map<string, LocalWorktreeRuntime>();

	constructor(
		deps: LocalWorktreeRuntimeDeps,
		resolveWorktree: WorktreeResolver,
	) {
		this.deps = deps;
		this.resolveWorktree = resolveWorktree;
	}

	async createInstance<R extends RuntimeRole>(
		plan: RuntimePlan<R>,
	): Promise<RuntimeHandleFor<R>> {
		// The worktree already exists — the facade ran `git worktree add` (or
		// adopted one) before calling createInstance. This binds that path into a
		// handle and MUST NOT re-create the worktree.
		const worktreePath = this.resolveWorktree(plan.workspaceId);
		if (!worktreePath) {
			throw new Error(
				`local-worktree: no worktree bound for workspace ${plan.workspaceId}`,
			);
		}
		const runtime = new LocalWorktreeRuntime(this.deps, {
			workspaceId: plan.workspaceId,
			worktreePath,
		});
		this.instances.set(runtime.externalId, runtime);
		return runtime as unknown as RuntimeHandleFor<R>;
	}

	async reconnect(externalId: string): Promise<RuntimeHandleFor<RuntimeRole>> {
		const existing = this.instances.get(externalId);
		if (existing) return existing;
		// keep-disk: the worktree path is the external id; rebuild a handle over
		// it. workspaceId is not recoverable from the path alone, so the handle is
		// diff/status-capable but not shell-bound to a DB workspace until the
		// facade re-creates it. For v1 this is sufficient: reconnect is exercised
		// by the persistence contract, which only reads diff + status.
		const runtime = new LocalWorktreeRuntime(this.deps, {
			workspaceId: "",
			worktreePath: externalId,
		});
		this.instances.set(externalId, runtime);
		return runtime;
	}

	async getStatus(externalId: string): Promise<NormalizedRuntimeStatus> {
		const existing = this.instances.get(externalId);
		if (existing) return existing.getStatus();
		if (existsSync(externalId)) return { kind: "running" };
		return { kind: "destroyed" };
	}

	async destroy(externalId: string, _mode: CleanupMode): Promise<void> {
		// v1: the destroy saga in trpc/router/workspace-cleanup owns PTY dispose +
		// `git worktree remove`. Keeping the byte-for-byte destroy path there
		// avoids moving the 5-phase saga into the adapter this phase. Here destroy
		// only forgets the in-memory handle, which makes repeated destroy
		// idempotent (the structural contract asserts this).
		this.instances.delete(externalId);
	}
}
