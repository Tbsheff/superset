import { DAYTONA_DESCRIPTOR } from "../../descriptors/daytona.ts";
import {
	type ActivityLease,
	type CleanupMode,
	type ExecOptions,
	type ExecResult,
	type FileContentsRequest,
	type FileContentsResult,
	type GetDiffOptions,
	type NormalizedRuntimeStatus,
	type PreviewBinding,
	type RuntimeDiff,
	type RuntimeFileInfo,
	type RuntimeFsApi,
	type RuntimeFsMatch,
	RuntimeProviderError,
	type ShellHandle,
	type StartShellOptions,
	type WorkspaceRuntime,
} from "../../seam/index.ts";
import { DaytonaActivityLease } from "./DaytonaActivityLease.ts";
import { DaytonaPtyTransport, type PtySandbox } from "./DaytonaPtyTransport.ts";
import {
	type EgressPolicy,
	toDaytonaNetwork,
	validateEgress,
} from "./egress.ts";
import { mapDaytonaState } from "./status-map.ts";
import type { DaytonaInstanceStore, Sandbox } from "./types.ts";

/**
 * The `Sandbox` surface the runtime handle needs. A `Pick` keeps the unit-test
 * fake honest and documents exactly which SDK verbs the handle touches.
 */
export type RuntimeSandbox = Pick<
	Sandbox,
	| "id"
	| "state"
	| "process"
	| "fs"
	| "getPreviewLink"
	| "refreshActivity"
	| "updateNetworkSettings"
> &
	PtySandbox;

export interface DaytonaWorkspaceRuntimeDeps {
	store: DaytonaInstanceStore;
	now: () => number;
}

/**
 * `WorkspaceRuntime` handle backed by a live Daytona sandbox. It COORDINATES the
 * SDK — PTY via `DaytonaPtyTransport`, diff via the same git commands the Phase D
 * collector runs (executed in-sandbox), preview via `getPreviewLink`, keep-alive
 * via the in-memory `DaytonaActivityLease` — and owns no new git logic.
 */
export class DaytonaWorkspaceRuntime implements WorkspaceRuntime {
	readonly role = "workspace" as const;
	readonly descriptor = DAYTONA_DESCRIPTOR;

	private lease: DaytonaActivityLease | null = null;
	private readonly transports = new Set<DaytonaPtyTransport>();

	constructor(
		private readonly sandbox: RuntimeSandbox,
		private readonly deps: DaytonaWorkspaceRuntimeDeps,
		/** The directory the repo was cloned into (sandbox-relative). */
		private readonly workdir = "workspace",
	) {}

	get externalId(): string {
		return this.sandbox.id;
	}

	async startShell(opts: StartShellOptions): Promise<ShellHandle> {
		const paneId = `${this.sandbox.id}-${this.deps.now()}`;
		const transport = new DaytonaPtyTransport(this.sandbox, paneId);
		this.transports.add(transport);
		await transport.start({
			cols: opts.cols ?? 80,
			rows: opts.rows ?? 24,
			cwd: opts.cwd ?? this.workdir,
			envs: opts.env,
		});
		return {
			surface: { kind: "pty" },
			write: (data) => {
				void transport.write(data);
			},
			resize: (cols, rows) => {
				void transport.resize(cols, rows);
			},
			onData: (cb) => transport.onData(cb),
			onExit: (cb) => {
				transport.onExit(({ exitCode }) => cb({ exitCode }));
				return { dispose: () => {} };
			},
			kill: async () => {
				await transport.kill();
				this.transports.delete(transport);
			},
		};
	}

	/**
	 * Runs the SAME git commands the Phase D `collectWorkspacePatch` runs, but
	 * in-sandbox via `executeCommand`, then maps to `RuntimeDiff` with the SAME
	 * projection the local runtime uses (`status` -> statusPorcelain; staged or
	 * unstaged binary diff -> unifiedPatch). Identical inputs therefore yield
	 * byte-identical output to local.
	 */
	async getDiff(opts?: GetDiffOptions): Promise<RuntimeDiff> {
		const run = (cmd: string) =>
			this.sandbox.process
				.executeCommand(cmd, this.workdir)
				.then((r) => r.result ?? "")
				.catch(() => "");
		const [statusPorcelain, unstaged, staged] = await Promise.all([
			run("git status --porcelain=v1 -z"),
			run("git diff --binary"),
			run("git diff --cached --binary"),
		]);
		return {
			statusPorcelain,
			unifiedPatch: opts?.staged ? staged : unstaged,
		};
	}

	/**
	 * Per-file before/after CONTENT, run in-sandbox via `executeCommand`. Mirrors
	 * the local `collectFileDiff` projection 1:1 (same refs per category, same
	 * empty-on-miss degradation) so the Changes view renders byte-identically for
	 * remote and local. `git show <ref>` resolves committed/staged content;
	 * `cat -- <path>` reads the working-tree file for the unstaged "new" side.
	 *
	 * `against-base` resolves the merge base the same way the local collector does
	 * (`merge-base <baseRef> HEAD`, falling back to the base ref) so the remote
	 * diff excludes unrelated base-branch commits landed after the fork point.
	 */
	async getFileContents(req: FileContentsRequest): Promise<FileContentsResult> {
		const run = (cmd: string) =>
			this.sandbox.process
				.executeCommand(cmd, this.workdir)
				.then((r) => (r.exitCode === 0 ? (r.result ?? "") : ""))
				.catch(() => "");
		const quotePath = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
		const path = quotePath(req.path);

		let oldContents = "";
		let newContents = "";

		if (req.category === "against-base") {
			const baseRef = (
				await run(
					`git rev-parse ${
						req.baseBranch ? quotePath(req.baseBranch) : "HEAD"
					}`,
				)
			).trim();
			const ref = baseRef || "HEAD";
			const mergeBase = (await run(`git merge-base ${ref} HEAD`)).trim() || ref;
			oldContents = await run(
				`git show ${quotePath(`${mergeBase}:${req.path}`)}`,
			);
			newContents = await run(`git show ${quotePath(`HEAD:${req.path}`)}`);
		} else if (req.category === "staged") {
			oldContents = await run(`git show ${quotePath(`HEAD:${req.path}`)}`);
			newContents = await run(`git show ${quotePath(`:0:${req.path}`)}`);
		} else if (req.category === "commit") {
			if (!req.commitHash) {
				throw new Error("commitHash is required for commit diffs");
			}
			const from = req.fromHash ?? `${req.commitHash}^`;
			oldContents = await run(`git show ${quotePath(`${from}:${req.path}`)}`);
			newContents = await run(
				`git show ${quotePath(`${req.commitHash}:${req.path}`)}`,
			);
		} else {
			// Unstaged: index (staged) version vs. working tree. A miss on the index
			// side leaves oldContents empty so an untracked file renders as new.
			oldContents = await run(`git show ${quotePath(`:0:${req.path}`)}`);
			newContents = await run(`cat -- ${path}`);
		}

		const fileName = req.path.split("/").pop() ?? req.path;
		return {
			oldFile: { name: fileName, contents: oldContents },
			newFile: { name: fileName, contents: newContents },
		};
	}

	/**
	 * Collects the working-tree patch as a git bundle inside the sandbox and
	 * downloads it to the host, where the scoped token lives, so a broad token
	 * never enters the sandbox. Returns the raw bytes; the host-side push
	 * (Step 6b, wired in the desktop/api layer) applies and pushes it.
	 */
	async exportPatch(): Promise<Buffer> {
		const remotePath = `${this.workdir}/.superset-export.patch`;
		await this.sandbox.process.executeCommand(
			`git format-patch --binary --stdout HEAD > ${remotePath} || git diff --binary > ${remotePath}`,
			this.workdir,
		);
		return this.sandbox.fs.downloadFile(remotePath);
	}

	/**
	 * One-shot command via the SDK's `executeCommand`. Daytona folds stderr into
	 * the same `result` stream, so `stderr` is always empty and the combined
	 * output lands in `stdout`. `timeoutMs` rounds up to whole seconds (the SDK's
	 * unit); 0/undefined leaves the SDK default.
	 */
	async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
		const cwd = opts?.cwd ?? this.workdir;
		const timeoutSec = opts?.timeoutMs
			? Math.max(1, Math.ceil(opts.timeoutMs / 1000))
			: undefined;
		const res = await this.sandbox.process.executeCommand(
			command,
			cwd,
			opts?.env,
			timeoutSec,
		);
		return {
			stdout: res.result ?? "",
			stderr: "",
			exitCode: res.exitCode ?? 0,
		};
	}

	/**
	 * Raw sandbox filesystem verbs for host-side file browsing/editing. Paths are
	 * sandbox-relative (the SDK resolves them against the user home, where the
	 * repo lives under `this.workdir`); `DaytonaFsService` is responsible for
	 * translating renderer paths into that space. `copyFiles`/`findFiles` have no
	 * direct SDK verb, so they run `cp -r`/`grep` via `exec`.
	 */
	runtimeFs(): RuntimeFsApi {
		const fs = this.sandbox.fs;
		const toFileInfo = (info: {
			name: string;
			isDir: boolean;
			size: number;
			mode: string;
			modTime: string;
			permissions: string;
		}): RuntimeFileInfo => ({
			name: info.name,
			isDir: info.isDir,
			size: info.size,
			mode: info.mode,
			modTime: info.modTime,
			permissions: info.permissions,
		});
		const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
		return {
			listFiles: async (path) => (await fs.listFiles(path)).map(toFileInfo),
			getFileDetails: async (path) => toFileInfo(await fs.getFileDetails(path)),
			downloadFile: (path) => fs.downloadFile(path),
			uploadFile: (content, path) => fs.uploadFile(content, path),
			createFolder: (path, mode) => fs.createFolder(path, mode),
			deleteFile: (path, recursive) => fs.deleteFile(path, recursive),
			moveFiles: (source, destination) => fs.moveFiles(source, destination),
			copyFiles: async (source, destination) => {
				const res = await this.exec(
					`cp -r ${quote(source)} ${quote(destination)}`,
				);
				if (res.exitCode !== 0) {
					throw new Error(
						`Failed to copy ${source} -> ${destination}: ${res.stdout}`,
					);
				}
			},
			searchFiles: async (path, pattern) =>
				(await fs.searchFiles(path, pattern)).files,
			findFiles: async (path, pattern): Promise<RuntimeFsMatch[]> => {
				const matches = await fs.findFiles(path, pattern);
				return matches.map((m) => ({
					file: m.file,
					line: m.line,
					content: m.content,
				}));
			},
		};
	}

	async exposePreview(port: number): Promise<PreviewBinding> {
		const link = await this.sandbox.getPreviewLink(port);
		// Persist ONLY the host-shaped origin URL; the access token rides a header
		// (`x-daytona-preview-token`), never the URL, and is never persisted —
		// the standard token resets on restart, so caching it would leak a stale
		// secret. exposePreview re-fetches every call.
		this.deps.store.setPreviewUrl(this.sandbox.id, link.url);
		return { url: link.url, tokenScheme: "standard" };
	}

	/** Validates + applies an egress policy; tier-gating surfaces a typed error. */
	async setEgress(policy: EgressPolicy): Promise<void> {
		validateEgress(policy);
		try {
			await this.sandbox.updateNetworkSettings(toDaytonaNetwork(policy));
		} catch {
			throw new RuntimeProviderError(
				"EGRESS_TIER_GATED",
				"Daytona Tier 1/2 organizations cannot set sandbox-level network policy; upgrade to Tier 3/4 to control egress.",
			);
		}
	}

	activityLease(): ActivityLease {
		if (!this.lease) {
			this.lease = new DaytonaActivityLease(this.sandbox);
			this.lease.start();
		}
		return this.lease;
	}

	async getStatus(): Promise<NormalizedRuntimeStatus> {
		return mapDaytonaState(this.sandbox.state);
	}

	/**
	 * On destroy, release the keep-alive lease and kill any live PTY first so no
	 * orphaned timer or socket outlives the sandbox. The adapter performs the
	 * actual `sdk.delete`; stop (keep-disk) only tears down host-side resources.
	 */
	async stop(_mode: CleanupMode): Promise<void> {
		await this.releaseResources();
	}

	/** Releases the in-memory lease + all PTY transports. Idempotent. */
	async releaseResources(): Promise<void> {
		if (this.lease) {
			await this.lease.release();
			this.lease = null;
		}
		for (const transport of this.transports) {
			await transport.kill().catch(() => {});
		}
		this.transports.clear();
	}
}
