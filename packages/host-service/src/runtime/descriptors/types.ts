import type {
	ActivityStrategy,
	DurableStore,
	EgressMode,
	ExecutionSurface,
	FilesystemFacet,
	IngressMode,
	OnStop,
} from "../seam/facets.ts";
import type { RuntimeRole } from "../seam/roles.ts";

export type {
	ActivityStrategy,
	DurableStore,
	EgressMode,
	ExecutionSurface,
	FilesystemFacet,
	IngressMode,
	OnStop,
} from "../seam/facets.ts";

/**
 * Static, doc-derived-then-integration-corrected capability shape of one
 * provider. Advertise ONLY what the provider actually does. Populated
 * member-by-member from real integrations — never authored speculatively.
 */
export interface ProviderDescriptor {
	readonly provider: string; // 'local-worktree' | 'daytona' | ...
	readonly roles: readonly RuntimeRole[];
	readonly execution: readonly ExecutionSurface[];
	readonly filesystem: readonly FilesystemFacet[];
	readonly ingress: readonly IngressMode[];
	readonly egress: readonly EgressMode[];
	readonly onStop: readonly OnStop[];
	readonly durableStore: readonly DurableStore[];
	readonly activity: readonly ActivityStrategy[];
}

/** The ONE way to ask a capability question. No call site re-derives from booleans. */
export const descriptorSupportsExecution = (
	d: ProviderDescriptor,
	kind: ExecutionSurface["kind"],
): boolean => d.execution.some((e) => e.kind === kind);

export const descriptorSupportsEgress = (
	d: ProviderDescriptor,
	kind: EgressMode["kind"],
): boolean => d.egress.some((e) => e.kind === kind);

export const descriptorSupportsRole = (
	d: ProviderDescriptor,
	role: RuntimeRole,
): boolean => d.roles.includes(role);

export const descriptorSupportsFilesystem = (
	d: ProviderDescriptor,
	kind: FilesystemFacet["kind"],
): boolean => d.filesystem.some((f) => f.kind === kind);

export const descriptorSupportsOnStop = (
	d: ProviderDescriptor,
	kind: OnStop["kind"],
): boolean => d.onStop.some((o) => o.kind === kind);

export const descriptorSupportsActivity = (
	d: ProviderDescriptor,
	kind: ActivityStrategy["kind"],
): boolean => d.activity.some((a) => a.kind === kind);

/** Filesystem providers that let callers write keep a working tree on disk. */
export const descriptorHasWritableFilesystem = (
	d: ProviderDescriptor,
): boolean => descriptorSupportsFilesystem(d, "read-write-list");

/** keep-disk OR keep-disk-and-memory both retain the working tree across stop. */
export const descriptorRetainsDiskOnStop = (d: ProviderDescriptor): boolean =>
	descriptorSupportsOnStop(d, "keep-disk") ||
	descriptorSupportsOnStop(d, "keep-disk-and-memory");
