/**
 * Host-local lifecycle vocabulary for the `runtime_instances.status` column.
 *
 * Single source of truth is `runtime/status.ts` (Phase 0/A): the canonical
 * normalized status set and its projection from the dormant cloud
 * `sandboxStatus` enum live there. This module re-exports it for the DB layer so
 * the SQLite `status` column and the runtime seam cannot drift.
 *
 * Cloud ↔ host field mapping (the cloud `cloudWorkspaceConfigSchema` /
 * `sandboxStatusEnum` in `packages/db` stays the cloud projection; host
 * `runtime_instances` is the source of truth for local-execution metadata and is
 * NOT unified with the cloud config in v1):
 *
 *   cloud `cloudWorkspaceConfigSchema` | host `runtime_instances` | source of truth
 *   -----------------------------------|--------------------------|------------------
 *   modalSandboxId / modalObjectId     | externalId               | host (local exec)
 *   status (sandboxStatusEnum)         | status (Normalized…)     | host for local exec; cloud projection unchanged
 *   lastActivityAt                     | lastActivityAt           | host (epoch ms vs cloud ISO string)
 *   snapshotImageId                    | (deferred snapshot ref)  | —
 */
export {
	cloudToNormalizedStatus,
	type NormalizedRuntimeStatus,
	normalizedRuntimeStatusValues,
} from "../../runtime/status.ts";
