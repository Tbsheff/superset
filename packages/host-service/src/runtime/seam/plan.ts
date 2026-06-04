import type { EgressMode } from "./facets.ts";
import type { RuntimeRole } from "./roles.ts";

/**
 * Inputs to createInstance, role-parameterized. v1 plan is intentionally thin;
 * RuntimePlanner validation rules are deferred. v1 validation = "provider exists
 * and supports role workspace", checked against the descriptor.
 */
export interface RuntimePlan<R extends RuntimeRole = RuntimeRole> {
	readonly role: R;
	readonly workspaceId: string;
	// `ref` is the BASE ref to clone (empty => the repo's default branch).
	// `createBranch`, if set, is created + checked out after the clone — used when
	// the workspace branch does not exist on the remote yet.
	readonly repo: { cloneUrl: string; ref: string; createBranch?: string };
	readonly egress?: EgressMode; // default deny-all enforced by adapter for untrusted code
	readonly env?: Record<string, string>;
}
