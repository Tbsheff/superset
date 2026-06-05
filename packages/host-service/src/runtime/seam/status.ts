/** Normalized lifecycle state across providers; provider strings map INTO this. */
export type NormalizedRuntimeStatus =
	| { kind: "creating" }
	| { kind: "running" }
	| {
			kind: "stopped";
			resumable: boolean;
			/**
			 * Whether the stopped runtime is ARCHIVED (disk evicted to cold/object
			 * storage) rather than merely stopped (disk retained). Resuming an
			 * archived runtime restores from cold storage and is much slower, so
			 * callers size their resume timeout and user-facing copy off this. Absent
			 * means "not archived" (a plain stop), so existing producers need no change.
			 */
			archived?: boolean;
	  }
	| { kind: "destroyed" }
	| { kind: "failed"; reason: string };
