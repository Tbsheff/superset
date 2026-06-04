import type { NormalizedRuntimeStatus } from "../../seam/index.ts";
import type { NormalizedRuntimeStatus as StoredRuntimeStatus } from "../../status.ts";

/**
 * Daytona's lifecycle vocabulary. Values are verbatim from
 * `@daytonaio/sdk`'s `SandboxState` (api-client `sandbox-state`), kept as a
 * widened `string` input so an unseen future state falls through to `failed`
 * with a clear reason rather than crashing the mapper.
 */
export type SandboxStateValue = string;

/**
 * Projects a Daytona `SandboxState` onto the seam's discriminated
 * `NormalizedRuntimeStatus`. Exhaustive over the documented enum; unknown values
 * surface as a `failed` status carrying the raw state so the caller can see what
 * the provider reported instead of a silent `running`.
 *
 *   creating / starting / restoring / pulling_snapshot / pending_build /
 *     building_snapshot / forking  -> creating  (bring-up, not yet usable)
 *   started / resizing                         -> running
 *   stopping / stopped / archiving / archived  -> stopped (resumable: disk kept)
 *   snapshotting                               -> running (still alive)
 *   destroying / destroyed                     -> destroyed
 *   error / build_failed                       -> failed
 *   unknown / anything else                    -> failed (raw state in reason)
 */
export function mapDaytonaState(
	state: SandboxStateValue | undefined,
): NormalizedRuntimeStatus {
	switch (state) {
		case "creating":
		case "starting":
		case "restoring":
		case "pulling_snapshot":
		case "pending_build":
		case "building_snapshot":
		case "forking":
			return { kind: "creating" };
		case "started":
		case "resizing":
		case "snapshotting":
			return { kind: "running" };
		case "stopping":
		case "stopped":
		case "archiving":
		case "archived":
			return { kind: "stopped", resumable: true };
		case "destroying":
		case "destroyed":
			return { kind: "destroyed" };
		case "error":
		case "build_failed":
			return { kind: "failed", reason: state };
		default:
			return {
				kind: "failed",
				reason: `unknown daytona state: ${state ?? "undefined"}`,
			};
	}
}

/**
 * Projects the seam's discriminated status onto the stored string vocabulary
 * (`runtime_instances.status`). The stored set has no `destroyed` member — a
 * destroyed instance is recorded as `stopped` plus a `destroyedAt` timestamp —
 * and no `creating`, which collapses to the stored `starting`.
 */
export function toStoredStatus(
	status: NormalizedRuntimeStatus,
): StoredRuntimeStatus {
	switch (status.kind) {
		case "creating":
			return "starting";
		case "running":
			return "running";
		case "stopped":
		case "destroyed":
			return "stopped";
		case "failed":
			return "failed";
	}
}
