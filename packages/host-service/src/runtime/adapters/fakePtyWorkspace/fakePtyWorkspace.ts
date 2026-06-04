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
import {
	applyShellCommand,
	createRefreshActivityLease,
	InMemoryFs,
} from "../fakeWorkspaceCore/index.ts";
import { fakePtyWorkspaceDescriptor } from "./descriptor.ts";

type Lifecycle = "running" | "stopped";

interface Instance {
	externalId: string;
	fs: InMemoryFs;
	lifecycle: Lifecycle;
}

export interface FakePtyWorkspaceOptions {
	now?: () => number;
}

/**
 * Fully in-memory RuntimeAdapter with a first-class PTY surface. The shell
 * interprets the contract command grammar (WRITE/RM/STAGE) against an in-memory
 * FS and echoes output back through onData, so the same handle drives the real
 * renderer terminal. Keep-disk persistence: reconnect reuses the same FS.
 */
export function createFakePtyWorkspaceAdapter(
	opts?: FakePtyWorkspaceOptions,
): RuntimeAdapter {
	const now = opts?.now ?? Date.now;
	const instances = new Map<string, Instance>();
	let seq = 0;

	const makeHandle = (instance: Instance): WorkspaceRuntime => ({
		role: "workspace",
		externalId: instance.externalId,
		async startShell(_options: StartShellOptions): Promise<ShellHandle> {
			return createPtyShell(instance);
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
			return createRefreshActivityLease();
		},
		async getStatus(): Promise<NormalizedRuntimeStatus> {
			return statusOf(instance);
		},
		async stop(mode: CleanupMode): Promise<void> {
			if (mode.kind === "delete") {
				instances.delete(instance.externalId);
				return;
			}
			instance.lifecycle = "stopped";
		},
	});

	const createPtyShell = (instance: Instance): ShellHandle => {
		const dataCbs = new Set<(chunk: string) => void>();
		const exitCbs = new Set<
			(info: { exitCode: number; signal?: number }) => void
		>();
		return {
			surface: { kind: "pty" },
			write(data: string) {
				const out = applyShellCommand(instance.fs, data);
				for (const cb of dataCbs) cb(out);
			},
			resize(_cols: number, _rows: number) {
				// pty accepts resize as a no-op in the fake.
			},
			onData(cb) {
				dataCbs.add(cb);
				return {
					dispose() {
						dataCbs.delete(cb);
					},
				};
			},
			onExit(cb) {
				exitCbs.add(cb);
				return {
					dispose() {
						exitCbs.delete(cb);
					},
				};
			},
			async kill(_signal?: string) {
				for (const cb of exitCbs) cb({ exitCode: 0 });
			},
		};
	};

	const statusOf = (instance: Instance): NormalizedRuntimeStatus =>
		instance.lifecycle === "running"
			? { kind: "running" }
			: { kind: "stopped", resumable: true };

	return {
		descriptor: fakePtyWorkspaceDescriptor,
		async createInstance<R extends RuntimeRole>(plan: RuntimePlan<R>) {
			const externalId = `fake-pty-${++seq}-${now()}`;
			const instance: Instance = {
				externalId,
				fs: new InMemoryFs(),
				lifecycle: "running",
			};
			instances.set(externalId, instance);
			void plan;
			return makeHandle(instance) as never;
		},
		async reconnect(externalId: string) {
			const instance = instances.get(externalId);
			if (!instance) {
				throw new Error(`fake-pty-workspace: unknown externalId ${externalId}`);
			}
			// keep-disk: reuse the same FS; mark running again.
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
