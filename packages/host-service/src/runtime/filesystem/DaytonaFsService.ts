import type {
	FsContentMatch,
	FsEntry,
	FsEntryKind,
	FsHostService,
	FsMetadata,
	FsReadResult,
	FsSearchMatch,
	FsWatchEvent,
	FsWriteResult,
} from "@superset/workspace-fs/host";
import type {
	RuntimeFileInfo,
	RuntimeFsApi,
	WorkspaceRuntime,
} from "../seam/index.ts";

/**
 * `FsHostService` for a REMOTE (Daytona) workspace. The local service reads a
 * host-side worktree directly; here every verb resolves the live
 * `WorkspaceRuntime` lazily and forwards to its `runtimeFs()` (the in-sandbox
 * Daytona fs API), mapping `RuntimeFileInfo` to the same return shapes the local
 * service produces so the Files tab/editor render identically.
 *
 * Path convention: the renderer treats `sandboxRoot` (the workspace's
 * `runtimeRoot`, e.g. `"workspace"`) as the filesystem root and joins entry
 * paths under it. The Daytona fs API resolves relative paths against the user
 * home, where the repo is cloned at `sandboxRoot`, so an incoming renderer path
 * is already a valid sandbox path — we only normalize separators and strip a
 * leading slash. A path that escapes `sandboxRoot` is rejected, mirroring the
 * local service's root containment.
 */
export class DaytonaFsService implements FsHostService {
	private fsPromise: Promise<RuntimeFsApi> | null = null;

	constructor(
		private readonly resolveRuntime: () => Promise<WorkspaceRuntime>,
		private readonly workspaceId: string,
		private readonly sandboxRoot: string,
	) {}

	private async fs(): Promise<RuntimeFsApi> {
		// Memoize the reconnect so a burst of fs calls shares one resolution;
		// reset on failure so a transient sandbox error doesn't poison the cache.
		if (!this.fsPromise) {
			this.fsPromise = (async () => {
				const runtime = await this.resolveRuntime();
				const api = runtime.runtimeFs?.();
				if (!api) {
					throw new Error(
						`Remote workspace ${this.workspaceId} runtime does not expose a filesystem.`,
					);
				}
				return api;
			})().catch((error) => {
				this.fsPromise = null;
				throw error;
			});
		}
		return this.fsPromise;
	}

	/**
	 * Maps a renderer path to a sandbox-relative path. The renderer joins entry
	 * paths under `sandboxRoot`, so paths already begin with it; this normalizes
	 * separators, drops a leading slash, and enforces root containment.
	 */
	private toSandboxPath(input: string): string {
		const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "");
		const root = this.sandboxRoot.replace(/\\/g, "/").replace(/^\/+/, "");
		if (!root) {
			return normalized;
		}
		if (normalized === root || normalized.startsWith(`${root}/`)) {
			const rest = normalized.slice(root.length).replace(/^\/+/, "");
			if (rest.split("/").includes("..")) {
				throw new Error(`Path is outside workspace root: ${input}`);
			}
			return normalized;
		}
		// A path that doesn't start with the root is treated as root-relative.
		if (normalized.split("/").includes("..")) {
			throw new Error(`Path is outside workspace root: ${input}`);
		}
		return normalized ? `${root}/${normalized}` : root;
	}

	/** The renderer-facing absolute path for a sandbox-relative path. */
	private toAbsolutePath(sandboxPath: string): string {
		return sandboxPath.replace(/\\/g, "/").replace(/^\/+/, "");
	}

	private static kindFor(info: RuntimeFileInfo): FsEntryKind {
		if (info.isDir) {
			return "directory";
		}
		if (info.mode.startsWith("L") || info.mode.startsWith("l")) {
			return "symlink";
		}
		return "file";
	}

	private static revisionFor(info: RuntimeFileInfo): string {
		return `${info.modTime}:${info.size}`;
	}

	async listDirectory(input: {
		absolutePath: string;
	}): Promise<{ entries: FsEntry[] }> {
		const fs = await this.fs();
		const dir = this.toSandboxPath(input.absolutePath);
		const infos = await fs.listFiles(dir);
		const entries: FsEntry[] = infos.map((info) => ({
			absolutePath: this.toAbsolutePath(
				dir ? `${dir}/${info.name}` : info.name,
			),
			name: info.name,
			kind: DaytonaFsService.kindFor(info),
		}));
		entries.sort((left, right) => {
			const leftIsDir = left.kind === "directory";
			const rightIsDir = right.kind === "directory";
			if (leftIsDir !== rightIsDir) {
				return leftIsDir ? -1 : 1;
			}
			return left.name.localeCompare(right.name);
		});
		return { entries };
	}

	async readFile(input: {
		absolutePath: string;
		offset?: number;
		maxBytes?: number;
		encoding?: string;
	}): Promise<FsReadResult> {
		const fs = await this.fs();
		const path = this.toSandboxPath(input.absolutePath);
		const [buffer, info] = await Promise.all([
			fs.downloadFile(path),
			fs.getFileDetails(path).catch(() => null),
		]);
		const revision = info
			? DaytonaFsService.revisionFor(info)
			: `${buffer.length}`;

		const start = input.offset ?? 0;
		let slice = start > 0 ? buffer.subarray(start) : buffer;
		let exceededLimit = false;
		if (input.maxBytes !== undefined && slice.length > input.maxBytes) {
			slice = slice.subarray(0, input.maxBytes);
			exceededLimit = true;
		}

		if (input.encoding) {
			return {
				kind: "text",
				content: slice.toString(input.encoding as BufferEncoding),
				byteLength: slice.length,
				exceededLimit,
				revision,
			};
		}
		return {
			kind: "bytes",
			content: new Uint8Array(slice),
			byteLength: slice.length,
			exceededLimit,
			revision,
		};
	}

	async getMetadata(input: {
		absolutePath: string;
	}): Promise<FsMetadata | null> {
		const fs = await this.fs();
		const path = this.toSandboxPath(input.absolutePath);
		let info: RuntimeFileInfo;
		try {
			info = await fs.getFileDetails(path);
		} catch {
			return null;
		}
		return {
			absolutePath: this.toAbsolutePath(path),
			kind: DaytonaFsService.kindFor(info),
			size: info.size,
			createdAt: null,
			modifiedAt: info.modTime || null,
			accessedAt: null,
			permissions: info.permissions || null,
			revision: DaytonaFsService.revisionFor(info),
		};
	}

	async writeFile(input: {
		absolutePath: string;
		content: string | Uint8Array;
		encoding?: string;
		options?: { create: boolean; overwrite: boolean };
		precondition?: { ifMatch: string };
	}): Promise<FsWriteResult> {
		const fs = await this.fs();
		const path = this.toSandboxPath(input.absolutePath);

		const existing = await fs.getFileDetails(path).catch(() => null);

		if (input.precondition?.ifMatch !== undefined) {
			const currentRevision = existing
				? DaytonaFsService.revisionFor(existing)
				: "";
			if (currentRevision !== input.precondition.ifMatch) {
				return { ok: false, reason: "conflict", currentRevision };
			}
		}

		const create = input.options?.create ?? true;
		const overwrite = input.options?.overwrite ?? true;
		if (existing && !overwrite) {
			return { ok: false, reason: "exists" };
		}
		if (!existing && !create) {
			return { ok: false, reason: "not-found" };
		}

		const buffer =
			typeof input.content === "string"
				? Buffer.from(
						input.content,
						(input.encoding as BufferEncoding) ?? "utf-8",
					)
				: Buffer.from(input.content);
		await fs.uploadFile(buffer, path);

		const after = await fs.getFileDetails(path).catch(() => null);
		return {
			ok: true,
			revision: after
				? DaytonaFsService.revisionFor(after)
				: `${buffer.length}`,
		};
	}

	async createDirectory(input: {
		absolutePath: string;
		recursive?: boolean;
	}): Promise<{ absolutePath: string; kind: "directory" }> {
		const fs = await this.fs();
		const path = this.toSandboxPath(input.absolutePath);
		await fs.createFolder(path, "755");
		return { absolutePath: this.toAbsolutePath(path), kind: "directory" };
	}

	async deletePath(input: {
		absolutePath: string;
		permanent?: boolean;
	}): Promise<{ absolutePath: string }> {
		const fs = await this.fs();
		const path = this.toSandboxPath(input.absolutePath);
		await fs.deleteFile(path, true);
		return { absolutePath: this.toAbsolutePath(path) };
	}

	async movePath(input: {
		sourceAbsolutePath: string;
		destinationAbsolutePath: string;
	}): Promise<{ fromAbsolutePath: string; toAbsolutePath: string }> {
		const fs = await this.fs();
		const from = this.toSandboxPath(input.sourceAbsolutePath);
		const to = this.toSandboxPath(input.destinationAbsolutePath);
		await fs.moveFiles(from, to);
		return {
			fromAbsolutePath: this.toAbsolutePath(from),
			toAbsolutePath: this.toAbsolutePath(to),
		};
	}

	async copyPath(input: {
		sourceAbsolutePath: string;
		destinationAbsolutePath: string;
	}): Promise<{ fromAbsolutePath: string; toAbsolutePath: string }> {
		const fs = await this.fs();
		const from = this.toSandboxPath(input.sourceAbsolutePath);
		const to = this.toSandboxPath(input.destinationAbsolutePath);
		await fs.copyFiles(from, to);
		return {
			fromAbsolutePath: this.toAbsolutePath(from),
			toAbsolutePath: this.toAbsolutePath(to),
		};
	}

	async searchFiles(input: {
		query: string;
		includeHidden?: boolean;
		includePattern?: string;
		excludePattern?: string;
		limit?: number;
	}): Promise<{ matches: FsSearchMatch[] }> {
		const fs = await this.fs();
		const trimmed = input.query.trim();
		if (!trimmed) {
			return { matches: [] };
		}
		const root = this.toSandboxPath(this.sandboxRoot);
		const files = await fs.searchFiles(root, `*${trimmed}*`);
		const limit = input.limit ?? 20;
		const matches: FsSearchMatch[] = files.slice(0, limit).map((file) => {
			const absolutePath = this.toAbsolutePath(file);
			const relativePath = this.toRelative(absolutePath);
			return {
				absolutePath,
				relativePath,
				name: relativePath.split("/").pop() ?? relativePath,
				kind: "file" as const,
				score: 1,
			};
		});
		return { matches };
	}

	async searchContent(input: {
		query: string;
		includeHidden?: boolean;
		includePattern?: string;
		excludePattern?: string;
		limit?: number;
	}): Promise<{ matches: FsContentMatch[] }> {
		const fs = await this.fs();
		const trimmed = input.query.trim();
		if (!trimmed) {
			return { matches: [] };
		}
		const root = this.toSandboxPath(this.sandboxRoot);
		const hits = await fs.findFiles(root, trimmed);
		const limit = input.limit ?? 20;
		const matches: FsContentMatch[] = hits.slice(0, limit).map((hit) => {
			const absolutePath = this.toAbsolutePath(hit.file);
			return {
				absolutePath,
				relativePath: this.toRelative(absolutePath),
				line: hit.line,
				column: 1,
				preview: hit.content.trim().slice(0, 160),
			};
		});
		return { matches };
	}

	/**
	 * Live filesystem events for a remote workspace are not yet wired (the
	 * watcher slice owns this). Returns an iterator that yields nothing and ends
	 * on `return()` so a consumer's `for await` resolves immediately instead of
	 * blocking. TODO(remote-watch): poll or stream Daytona fs events here.
	 */
	watchPath(_input: {
		absolutePath: string;
		recursive?: boolean;
	}): AsyncIterable<{ events: FsWatchEvent[] }> {
		return {
			[Symbol.asyncIterator]() {
				return {
					next: async () => ({ value: undefined, done: true }),
					return: async () => ({ value: undefined, done: true }),
				};
			},
		};
	}

	async close(): Promise<void> {
		this.fsPromise = null;
	}

	private toRelative(absolutePath: string): string {
		const root = this.sandboxRoot.replace(/\\/g, "/").replace(/^\/+/, "");
		const normalized = absolutePath.replace(/\\/g, "/").replace(/^\/+/, "");
		if (root && normalized.startsWith(`${root}/`)) {
			return normalized.slice(root.length + 1);
		}
		return normalized;
	}
}
