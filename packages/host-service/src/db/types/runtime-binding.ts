export type RuntimeKind = "local" | "remote";

/**
 * Where a workspace runs. Discriminant + boundary refinement, NOT three loose
 * fields: a `local` binding cannot carry a `currentRuntimeId`, a `remote`
 * binding cannot carry a `worktreePath`. Same discipline as ResolvedRef
 * (runtime/git/refs.ts).
 */
export type RuntimeBinding =
	| { kind: "local"; worktreePath: string }
	| { kind: "remote"; currentRuntimeId: string };

/** Boundary refinement: local ⇒ worktreePath; remote ⇒ currentRuntimeId. */
export function toRuntimeBinding(row: {
	runtimeKind: string;
	worktreePath: string;
	currentRuntimeId: string | null;
}): RuntimeBinding {
	if (row.runtimeKind === "remote") {
		if (!row.currentRuntimeId) {
			throw new Error(
				"Invalid runtime binding: runtimeKind='remote' requires a currentRuntimeId",
			);
		}
		return { kind: "remote", currentRuntimeId: row.currentRuntimeId };
	}
	return { kind: "local", worktreePath: row.worktreePath };
}
