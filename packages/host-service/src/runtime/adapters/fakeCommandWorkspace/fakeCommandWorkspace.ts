import type {
	ActivityLease,
	CleanupMode,
	GetDiffOptions,
	NormalizedRuntimeStatus,
	PreviewBinding,
	RuntimeAdapter,
	RuntimeDiff,
	RuntimePlan,
	RuntimeRole,
	ShellHandle,
	StartShellOptions,
	WorkspaceRuntime,
} from "../../seam/index.ts";
import { UnsupportedExecutionError } from "../../seam/index.ts";
import {
	applyShellCommand,
	createHardCapLease,
	InMemoryFs,
} from "../fakeWorkspaceCore/index.ts";
import { fakeCommandWorkspaceDescriptor } from "./descriptor.ts";

type Lifecycle = "running" | "stopped";

interface Instance {
	externalId: string;
	fs: InMemoryFs;
	lifecycle: Lifecycle;
	createdAt: number;
}

export interface FakeCommandWorkspaceOptions {
	now?: () => number;
}

export interface FakeCommandWorkspaceAdapter extends RuntimeAdapter {
	/** Advance the injectable clock; lets the hard-cap lease contract cross the cap. */
	advanceClock(ms: number): void;
}

/**
 * Fully in-memory RuntimeAdapter with a streaming-command surface (NO interactive
 * shell). startShell runs the command passed via env.CONTRACT_CMD against an
 * in-memory FS, streams a log then exits; interactive write/resize reject with a
 * typed UnsupportedExecutionError. Discard persistence: reconnect returns a fresh
 * empty FS. Hard-cap activity via an injectable clock.
 */
export function createFakeCommandWorkspaceAdapter(
	opts?: FakeCommandWorkspaceOptions,
): FakeCommandWorkspaceAdapter {
	let clockOffset = 0;
	const wall = opts?.now ?? Date.now;
	const now = () => wall() + clockOffset;
	const instances = new Map<string, Instance>();
	let seq = 0;

	const makeHandle = (instance: Instance): WorkspaceRuntime => ({
		role: "workspace",
		externalId: instance.externalId,
		async startShell(options: StartShellOptions): Promise<ShellHandle> {
			return createCommandShell(instance, options);
		},
		async getDiff(options?: GetDiffOptions): Promise<RuntimeDiff> {
			return instance.fs.diff(options?.staged ?? false);
		},
		async exposePreview(port: number): Promise<PreviewBinding> {
			return {
				url: `https://${instance.externalId}-${port}.preview.fake.test`,
				tokenScheme: "standard",
			};
		},
		activityLease(): ActivityLease {
			return createHardCapLease(
				fakeCommandWorkspaceDescriptor.activity[0]?.kind === "hard-cap"
					? fakeCommandWorkspaceDescriptor.activity[0].maxMs
					: 60_000,
				now,
			);
		},
		async getStatus(): Promise<NormalizedRuntimeStatus> {
			return statusOf(instance);
		},
		async stop(mode: CleanupMode): Promise<void> {
			if (mode.kind === "delete") {
				instances.delete(instance.externalId);
				return;
			}
			// discard: stopping wipes the FS even when keepDisk is requested,
			// because this provider does not persist disk on stop.
			instance.fs.clear();
			instance.lifecycle = "stopped";
		},
	});

	const createCommandShell = (
		instance: Instance,
		options: StartShellOptions,
	): ShellHandle => {
		const dataCbs = new Set<(chunk: string) => void>();
		const exitCbs = new Set<
			(info: { exitCode: number; signal?: number }) => void
		>();
		const command = options.env?.CONTRACT_CMD;

		// Run the command synchronously, then buffer the log + exit and replay them
		// to subscribers. Buffering (rather than firing on a timer) means a listener
		// attached any time after startShell still observes the full output — the
		// real streaming-command transports the renderer consumes behave this way.
		let body = "fake-command-workspace: ready\n";
		if (command) {
			body = applyShellCommand(instance.fs, command);
		}
		const exitInfo = { exitCode: 0 } as const;
		let drained = false;
		const drain = () => {
			if (drained) return;
			drained = true;
			for (const cb of dataCbs) cb(body);
			for (const cb of exitCbs) cb(exitInfo);
		};

		return {
			surface: { kind: "streaming-command" },
			write(_data: string) {
				throw new UnsupportedExecutionError("write", "streaming-command");
			},
			resize(_cols: number, _rows: number) {
				throw new UnsupportedExecutionError("resize", "streaming-command");
			},
			onData(cb) {
				dataCbs.add(cb);
				queueMicrotask(drain);
				return {
					dispose() {
						dataCbs.delete(cb);
					},
				};
			},
			onExit(cb) {
				exitCbs.add(cb);
				queueMicrotask(drain);
				return {
					dispose() {
						exitCbs.delete(cb);
					},
				};
			},
			async kill(_signal?: string) {
				if (!drained) drain();
				for (const cb of exitCbs) cb({ exitCode: 0, signal: 9 });
			},
		};
	};

	const statusOf = (instance: Instance): NormalizedRuntimeStatus =>
		instance.lifecycle === "running"
			? { kind: "running" }
			: { kind: "stopped", resumable: false };

	return {
		descriptor: fakeCommandWorkspaceDescriptor,
		advanceClock(ms: number) {
			clockOffset += ms;
		},
		async createInstance<R extends RuntimeRole>(plan: RuntimePlan<R>) {
			const externalId = `fake-cmd-${++seq}-${now()}`;
			const instance: Instance = {
				externalId,
				fs: new InMemoryFs(),
				lifecycle: "running",
				createdAt: now(),
			};
			instances.set(externalId, instance);
			void plan;
			return makeHandle(instance) as never;
		},
		async reconnect(externalId: string) {
			const instance = instances.get(externalId);
			if (!instance) {
				throw new Error(
					`fake-command-workspace: unknown externalId ${externalId}`,
				);
			}
			// discard: reconnect gets a FRESH empty FS.
			instance.fs = new InMemoryFs();
			instance.lifecycle = "running";
			return makeHandle(instance);
		},
		async getStatus(externalId: string): Promise<NormalizedRuntimeStatus> {
			const instance = instances.get(externalId);
			if (!instance) return { kind: "destroyed" };
			return statusOf(instance);
		},
		async destroy(externalId: string, _mode: CleanupMode): Promise<void> {
			instances.delete(externalId);
		},
	};
}
