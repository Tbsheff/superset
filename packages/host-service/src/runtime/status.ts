/**
 * Canonical runtime status vocabulary shared by Phase A (type seam) and Phase C
 * (runtime_instances schema). The cloud `sandboxStatus` enum is mirrored here as
 * a literal tuple (host-service does not depend on `@superset/db`) and the 11
 * cloud members are projected onto a normalized 6-value set so the two
 * vocabularies cannot silently diverge. See
 * plans/runtime-provider-phase0-reconciliation.md (Decision 3c).
 *
 * Note: the normalized set is NOT a strict subset of the cloud enum — `starting`
 * collapses the transient `spawning|connecting|warming|syncing` members. The
 * binding contract is `cloudToNormalizedStatus`: it must be total over the 11
 * cloud members, and every value it produces must be a NormalizedRuntimeStatus.
 * Both are enforced at compile time below and re-checked at runtime in
 * status.test.ts.
 */

const cloudSandboxStatusValues = [
	"pending",
	"spawning",
	"connecting",
	"warming",
	"syncing",
	"ready",
	"running",
	"stale",
	"snapshotting",
	"stopped",
	"failed",
] as const;
type CloudSandboxStatus = (typeof cloudSandboxStatusValues)[number];

export const normalizedRuntimeStatusValues = [
	"pending",
	"starting",
	"ready",
	"running",
	"stopped",
	"failed",
] as const;
export type NormalizedRuntimeStatus =
	(typeof normalizedRuntimeStatusValues)[number];

/**
 * Projection of the 11 cloud `sandboxStatus` members onto the 6 normalized
 * values. The five 1:1 members map to themselves; transient bring-up members
 * collapse to `starting`; `stale`/`snapshotting` collapse to `running` (the
 * runtime is still alive — a stopped/archived runtime reports `stopped`).
 *
 * Typed as `Record<CloudSandboxStatus, NormalizedRuntimeStatus>` so the compiler
 * enforces totality over the cloud enum AND that every target is normalized;
 * this is the binding subset/projection check.
 */
export const cloudToNormalizedStatus: Record<
	CloudSandboxStatus,
	NormalizedRuntimeStatus
> = {
	pending: "pending",
	spawning: "starting",
	connecting: "starting",
	warming: "starting",
	syncing: "starting",
	ready: "ready",
	running: "running",
	stale: "running",
	snapshotting: "running",
	stopped: "stopped",
	failed: "failed",
};
