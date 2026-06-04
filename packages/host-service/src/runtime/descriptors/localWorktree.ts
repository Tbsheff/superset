import type { ProviderDescriptor } from "./types.ts";

/**
 * The capability shape of today's local worktree, the first real adapter.
 * Mirrors `fakePtyWorkspaceDescriptor` exactly — that fake was authored to
 * stand in for local, so the contract that passes against the fake is the same
 * one this extraction must pass.
 *
 * `idleStopMs: Number.POSITIVE_INFINITY` encodes "never idle-stops": the local
 * worktree runs on the host network and its activity lease is a no-op. `egress`
 * is informational for local (host network); it does not gate anything.
 */
export const LOCAL_WORKTREE_DESCRIPTOR: ProviderDescriptor = {
	provider: "local-worktree",
	roles: ["workspace"],
	execution: [{ kind: "pty" }],
	filesystem: [{ kind: "read-write-list" }],
	ingress: [{ kind: "runtime-preview-url", tokenScheme: "standard" }],
	egress: [{ kind: "allow-all" }],
	onStop: [{ kind: "keep-disk" }],
	durableStore: [{ kind: "none" }],
	activity: [
		{ kind: "refresh-activity", idleStopMs: Number.POSITIVE_INFINITY },
	],
};
