/** Normalized lifecycle state across providers; provider strings map INTO this. */
export type NormalizedRuntimeStatus =
	| { kind: "creating" }
	| { kind: "running" }
	| { kind: "stopped"; resumable: boolean }
	| { kind: "destroyed" }
	| { kind: "failed"; reason: string };
