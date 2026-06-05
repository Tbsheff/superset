import type { PtyHandle } from "@daytonaio/sdk";
import {
	applyShellCommand,
	InMemoryFs,
} from "../../fakeWorkspaceCore/index.ts";
import type { DaytonaInstanceStore, RuntimeInstanceRecord } from "../types.ts";

/**
 * Deterministic in-memory model of one Daytona sandbox, enough to drive the
 * adapter unit tests and the descriptor-driven contract suite WITHOUT a network.
 * It interprets the contract WRITE/STAGE/RM grammar through `process.createPty`
 * and reflects the resulting FS state through `process.executeCommand` for the
 * `git status`/`git diff` surfaces the adapter's `getDiff` runs.
 */
export class FakeSandbox {
	state: string;
	readonly id: string;
	readonly target = "us";
	readonly fsModel = new InMemoryFs();
	recoverable?: boolean;
	errorReason?: string;

	readonly calls = {
		refreshActivity: 0,
		refreshData: 0,
		createPty: [] as string[],
		executeCommand: [] as string[],
		exec: [] as Array<{
			command: string;
			cwd?: string;
			env?: Record<string, string>;
		}>,
		clone: [] as Array<{
			url: string;
			path: string;
			branch?: string;
			username?: string;
			password?: string;
		}>,
		updateNetworkSettings: [] as Array<{
			networkBlockAll?: boolean;
			networkAllowList?: string;
		}>,
		killedPtys: [] as string[],
		started: 0,
		/** Timeout (seconds) passed to each `start()`; -1 means none was given. */
		startTimeouts: [] as number[],
		deleted: 0,
	};

	/** When set, the next updateNetworkSettings rejects (tier-gating). */
	tierGated = false;

	/** When non-zero, the shallow `git clone` reports this exit code. */
	cloneExitCode = 0;

	/** When >0, the next N `start()` calls throw (then decrement). */
	startFailuresRemaining = 0;

	/**
	 * When true, a failing `start()` also flips state to `started` — modeling a
	 * concurrent caller that resumed the sandbox while our start was failing, so
	 * the retry path sees it already running.
	 */
	setRunningOnFailedStart = false;

	constructor(id: string, state = "started", cloneExitCode = 0) {
		this.id = id;
		this.state = state;
		this.cloneExitCode = cloneExitCode;
	}

	readonly git = {
		clone: async (
			url: string,
			path: string,
			branch?: string,
			_commitId?: string,
			username?: string,
			password?: string,
		): Promise<void> => {
			this.calls.clone.push({ url, path, branch, username, password });
		},
	};

	readonly fs = {
		downloadFile: async (_remotePath: string): Promise<Buffer> =>
			Buffer.from("PATCH-BYTES"),
	};

	readonly process = {
		createPty: async (
			options: {
				id: string;
				onData: (data: Uint8Array) => void | Promise<void>;
			} & Record<string, unknown>,
		): Promise<PtyHandle> => {
			this.calls.createPty.push(options.id);
			const fsModel = this.fsModel;
			const killed = this.calls.killedPtys;
			const encoder = new TextEncoder();
			const handle = {
				sessionId: options.id,
				exitCode: undefined as number | undefined,
				error: undefined as string | undefined,
				isConnected: () => true,
				waitForConnection: async () => {},
				sendInput: async (data: string | Uint8Array) => {
					const text =
						typeof data === "string" ? data : new TextDecoder().decode(data);
					const out = applyShellCommand(fsModel, text);
					await options.onData(encoder.encode(out));
				},
				resize: async () => ({}) as never,
				disconnect: async () => {},
				wait: async () => ({ exitCode: 0 }),
				kill: async () => {
					killed.push(options.id);
				},
			};
			return handle as unknown as PtyHandle;
		},
		connectPty: async (
			sessionId: string,
			options: { onData: (data: Uint8Array) => void | Promise<void> },
		): Promise<PtyHandle> => {
			return this.process.createPty({ id: sessionId, ...options });
		},
		executeCommand: async (
			command: string,
			_cwd?: string,
			env?: Record<string, string>,
		) => {
			this.calls.executeCommand.push(command);
			this.calls.exec.push({ command, cwd: _cwd, env });
			if (command.includes("--depth=1")) {
				return this.cloneExitCode === 0
					? { exitCode: 0, result: "" }
					: {
							exitCode: this.cloneExitCode,
							result: "fatal: simulated clone failure",
						};
			}
			if (command.includes("git status --porcelain")) {
				// Real `git status` reports a file with EITHER staged OR unstaged
				// changes, so the path stays visible after `git add`. The InMemoryFs
				// renders only one axis at a time, so union both for porcelain.
				const unstaged = this.fsModel.diff(false).statusPorcelain;
				const staged = this.fsModel.diff(true).statusPorcelain;
				const lines = new Set<string>();
				for (const block of [unstaged, staged]) {
					for (const line of block.split("\n")) {
						if (line.trim().length > 0) lines.add(line.trim());
					}
				}
				return { exitCode: 0, result: [...lines].join("\n") };
			}
			if (command.includes("git diff --cached")) {
				return { exitCode: 0, result: this.fsModel.diff(true).unifiedPatch };
			}
			if (command.includes("git diff")) {
				return { exitCode: 0, result: this.fsModel.diff(false).unifiedPatch };
			}
			return { exitCode: 0, result: "" };
		},
	};

	async refreshActivity(): Promise<void> {
		this.calls.refreshActivity += 1;
	}

	async refreshData(): Promise<void> {
		this.calls.refreshData += 1;
	}

	async getPreviewLink(port: number) {
		return {
			sandboxId: this.id,
			url: `https://${port}-${this.id}.proxy.daytona.test`,
			token: `secret-preview-token-${port}`,
		};
	}

	async updateNetworkSettings(settings: {
		networkBlockAll?: boolean;
		networkAllowList?: string;
	}): Promise<void> {
		if (this.tierGated) {
			throw new Error("403: tier does not allow network policy");
		}
		this.calls.updateNetworkSettings.push(settings);
	}

	async start(timeout?: number): Promise<void> {
		this.calls.startTimeouts.push(timeout ?? -1);
		if (this.startFailuresRemaining > 0) {
			this.startFailuresRemaining -= 1;
			if (this.setRunningOnFailedStart) this.state = "started";
			throw new Error("fake-sdk: simulated start failure");
		}
		this.calls.started += 1;
		this.state = "started";
	}
}

/** A fake `DaytonaSdk` backed by a registry of `FakeSandbox` state machines. */
export class FakeDaytonaSdk {
	readonly sandboxes = new Map<string, FakeSandbox>();
	private seq = 0;

	/** When non-zero, every sandbox this sdk creates fails its shallow clone. */
	cloneExitCode = 0;

	readonly lastCreate: {
		snapshot?: string;
		language?: string;
		networkBlockAll?: boolean;
		networkAllowList?: string;
	} = {};

	create = async (params?: {
		snapshot?: string;
		language?: string;
		networkBlockAll?: boolean;
		networkAllowList?: string;
	}) => {
		const id = `sbx-${++this.seq}`;
		const sandbox = new FakeSandbox(id, "started", this.cloneExitCode);
		this.sandboxes.set(id, sandbox);
		this.lastCreate.snapshot = params?.snapshot;
		this.lastCreate.language = params?.language;
		this.lastCreate.networkBlockAll = params?.networkBlockAll;
		this.lastCreate.networkAllowList = params?.networkAllowList;
		return sandbox as never;
	};

	get = async (id: string) => {
		const sandbox = this.sandboxes.get(id);
		if (!sandbox) throw new Error(`fake-sdk: unknown sandbox ${id}`);
		return sandbox as never;
	};

	stop = async (sandbox: { id: string }) => {
		const s = this.sandboxes.get(sandbox.id);
		if (s) s.state = "stopped";
	};

	delete = async (sandbox: { id: string }, _timeout?: number) => {
		const s = this.sandboxes.get(sandbox.id);
		if (s) {
			s.calls.deleted += 1;
			s.state = "destroyed";
		}
	};
}

/** In-memory `DaytonaInstanceStore` capturing every write for assertions. */
export class FakeInstanceStore implements DaytonaInstanceStore {
	readonly records = new Map<string, RuntimeInstanceRecord>();

	insert(record: RuntimeInstanceRecord): void {
		if (record.externalId) this.records.set(record.externalId, { ...record });
	}

	setPreviewUrl(externalId: string, previewUrl: string): void {
		const record = this.records.get(externalId);
		if (record) record.previewUrl = previewUrl;
	}

	markDestroyed(externalId: string, destroyedAt: number): void {
		const record = this.records.get(externalId);
		if (record) {
			record.destroyedAt = destroyedAt;
			record.status = "stopped";
		}
	}

	get(externalId: string): RuntimeInstanceRecord | undefined {
		return this.records.get(externalId);
	}
}
