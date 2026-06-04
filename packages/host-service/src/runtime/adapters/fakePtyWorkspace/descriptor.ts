import type { ProviderDescriptor } from "../../descriptors/index.ts";

/**
 * Mirrors the local-worktree capability shape (first-class PTY, full FS,
 * keep-disk on stop, refresh-activity heartbeat) so the contract that passes
 * here is the same one Phase E's local extraction must pass.
 */
export const fakePtyWorkspaceDescriptor: ProviderDescriptor = {
	provider: "fake-pty-workspace",
	roles: ["workspace"],
	execution: [{ kind: "pty" }],
	filesystem: [{ kind: "read-write-list" }],
	ingress: [{ kind: "runtime-preview-url", tokenScheme: "standard" }],
	egress: [{ kind: "allow-all" }],
	onStop: [{ kind: "keep-disk" }],
	durableStore: [{ kind: "none" }],
	activity: [{ kind: "refresh-activity", idleStopMs: 900_000 }],
};
