/**
 * Where a workspace runs. Discriminant + boundary refinement, NOT three loose
 * fields. In Drizzle (Phase C) this becomes runtimeKind (discriminant) +
 * worktreePath (NOT NULL for v1) + nullable currentRuntimeId, with a zod/CHECK
 * refinement — same discipline as ResolvedRef (runtime/git/refs.ts).
 */
export type RuntimeBinding =
	| { kind: "local"; worktreePath: string }
	| { kind: "remote"; runtimeId: string };
