import type { ProviderDescriptor } from "./types.ts";

/**
 * Daytona's real capability shape — advertise ONLY what the provider does.
 *
 * - execution: first-class PTY (`process.createPty`), no stderr-mux caveat.
 * - ingress: a runtime-level preview origin (`getPreviewLink`, standard token in
 *   a header) plus a signed variant (`getSignedPreviewUrl`, TTL-bounded).
 * - egress: deny-all + allow-all + IPv4-CIDR allow list (`updateNetworkSettings`
 *   / create-time `networkBlockAll`/`networkAllowList`). The CIDR list is
 *   IPv4-only and capped at 10 entries here; tier-gating (Tier 1/2 cannot set
 *   sandbox-level policy) is a RUNTIME error from the API, not a missing mode —
 *   the descriptor still advertises the capability the provider exposes.
 * - onStop keep-disk: `stop` clears memory but keeps the filesystem; archive is
 *   out of v1 scope so durableStore is `none` (no snapshot reuse).
 * - activity: `refresh-activity` on a 15-minute idle stop (the create-time
 *   `autoStopInterval` default); the in-memory lease keeps it alive on a timer.
 */
export const DAYTONA_DESCRIPTOR: ProviderDescriptor = {
	provider: "daytona",
	roles: ["workspace"],
	execution: [{ kind: "pty" }],
	filesystem: [{ kind: "read-write-list" }],
	ingress: [
		{ kind: "runtime-preview-url", tokenScheme: "standard" },
		{
			kind: "runtime-preview-url",
			tokenScheme: "signed",
			defaultTtlSec: 3600,
			maxTtlSec: 86400,
		},
	],
	egress: [
		{ kind: "deny-all" },
		{ kind: "allow-all" },
		{ kind: "allow-cidrs", maxEntries: 10, ipv4Only: true },
	],
	onStop: [{ kind: "keep-disk" }],
	durableStore: [{ kind: "none" }],
	activity: [{ kind: "refresh-activity", idleStopMs: 15 * 60_000 }],
};
