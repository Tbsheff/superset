import type { ProviderDescriptor } from "../../descriptors/index.ts";

/**
 * Maximizes divergence from the PTY fake — the whole point of the non-PTY gate.
 * Streaming-command execution (no interactive shell), hard-cap activity (so it
 * exercises the must-rehydrate path), and discard-on-stop persistence (so it
 * exercises the discard branch of the persistence contract).
 */
export const fakeCommandWorkspaceDescriptor: ProviderDescriptor = {
	provider: "fake-command-workspace",
	roles: ["workspace"],
	execution: [{ kind: "streaming-command" }],
	filesystem: [{ kind: "read-write-list" }],
	ingress: [{ kind: "runtime-preview-url", tokenScheme: "standard" }],
	egress: [{ kind: "deny-all" }],
	onStop: [{ kind: "discard" }],
	durableStore: [{ kind: "none" }],
	activity: [{ kind: "hard-cap", maxMs: 60_000 }],
};
