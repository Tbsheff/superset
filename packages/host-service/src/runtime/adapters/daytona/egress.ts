import { RuntimeProviderError } from "../../seam/index.ts";

/**
 * A CONCRETE egress policy to apply to a sandbox. Distinct from the descriptor's
 * `EgressMode` facet (which advertises a CAPABILITY, not a value): the facet says
 * "this provider can do CIDR allow lists"; this carries the actual list. The
 * discriminant mirrors `EgressMode` so the mapping stays obvious.
 */
export type EgressPolicy =
	| { kind: "allow-all" }
	| { kind: "deny-all" }
	| { kind: "allow-cidrs"; cidrs: readonly string[] };

/**
 * Minimal default outbound allow list applied at create time. Deny-all is the
 * default; this list is the small set a dev workload legitimately needs (package
 * registries / proxy ranges). Keep it <= the descriptor's 10-entry cap and
 * IPv4-only. Operators tighten or widen it via `setEgress`.
 */
export const DEFAULT_DEV_CIDRS: readonly string[] = [
	"140.82.112.0/20", // github.com
	"185.199.108.0/22", // github pages / raw
	"104.16.0.0/13", // cloudflare (npm/registry CDNs)
];

export const MAX_EGRESS_CIDRS = 10;
const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** True only for a well-formed IPv4 CIDR with a 0..32 prefix length. */
export function isValidIpv4Cidr(entry: string): boolean {
	const match = IPV4_CIDR.exec(entry);
	if (!match) return false;
	const octets = [match[1], match[2], match[3], match[4]].map((o) => Number(o));
	if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
	const prefix = Number(match[5]);
	return prefix >= 0 && prefix <= 32;
}

/**
 * Rejects an invalid egress policy BEFORE any SDK round-trip: IPv4 CIDRs only,
 * each with a `/N` prefix, capped at 10 entries. A bad policy throws
 * `EGRESS_INVALID_CIDR` so the caller never ships a malformed allow list.
 */
export function validateEgress(policy: EgressPolicy): void {
	if (policy.kind !== "allow-cidrs") return;
	if (policy.cidrs.length > MAX_EGRESS_CIDRS) {
		throw new RuntimeProviderError(
			"EGRESS_INVALID_CIDR",
			`egress allow list exceeds ${MAX_EGRESS_CIDRS} entries (${policy.cidrs.length})`,
		);
	}
	for (const entry of policy.cidrs) {
		if (!isValidIpv4Cidr(entry)) {
			throw new RuntimeProviderError(
				"EGRESS_INVALID_CIDR",
				`invalid IPv4 CIDR in egress allow list: ${entry}`,
			);
		}
	}
}

/** Maps a concrete `EgressPolicy` to Daytona's network settings. */
export function toDaytonaNetwork(policy: EgressPolicy): {
	networkBlockAll?: boolean;
	networkAllowList?: string;
} {
	switch (policy.kind) {
		case "allow-all":
			return { networkBlockAll: false };
		case "deny-all":
			return { networkBlockAll: true };
		case "allow-cidrs":
			return {
				networkBlockAll: true,
				networkAllowList: policy.cidrs.join(","),
			};
	}
}
