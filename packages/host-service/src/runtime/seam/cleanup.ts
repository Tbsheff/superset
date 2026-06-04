/**
 * How destroy()/stop() should treat the runtime's disk + durable store.
 * Maps to provider verbs (Daytona stop vs archive vs delete) in the adapter.
 */
export type CleanupMode =
	| { kind: "stop"; keepDisk: boolean }
	| { kind: "delete" };
