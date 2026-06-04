export type ExecutionSurface =
	| { kind: "pty"; stderrMultiplexedIntoStdout?: boolean }
	| { kind: "streaming-command" };

export type IngressMode =
	| {
			kind: "runtime-preview-url";
			tokenScheme: "standard" | "signed";
			defaultTtlSec?: number;
			maxTtlSec?: number;
	  }
	| { kind: "declared-port-domain"; portsAtCreate: true; maxPorts: number };

export type EgressMode =
	| { kind: "allow-all" }
	| { kind: "deny-all" }
	| { kind: "allow-cidrs"; maxEntries: number; ipv4Only: true };

export type OnStop =
	| { kind: "discard" }
	| { kind: "keep-disk" }
	| { kind: "keep-disk-and-memory" };

export type DurableStore =
	| { kind: "none" }
	| {
			kind: "snapshot";
			persistentByDefault?: boolean;
			autoSnapshotOnStop?: boolean;
	  }
	| { kind: "volume"; syncSemantics: "on-terminate" | "manual" | "immediate" };

export type ActivityStrategy =
	| { kind: "refresh-activity"; idleStopMs: number }
	| { kind: "extend-timeout"; defaultMs: number; maxMs: number }
	| { kind: "hard-cap"; maxMs: number }
	| { kind: "keep-alive-or-destroy" };

export type FilesystemFacet = { kind: "none" } | { kind: "read-write-list" };
