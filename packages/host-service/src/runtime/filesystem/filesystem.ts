import {
	createFsHostService,
	type FsHostService,
	FsWatcherManager,
	getSearchIndex,
} from "@superset/workspace-fs/host";
import { eq } from "drizzle-orm";
import type { HostDb } from "../../db/index.ts";
import { projects, workspaces } from "../../db/schema.ts";
import type { WorkspaceRuntime } from "../seam/index.ts";
import { DaytonaFsService } from "./DaytonaFsService.ts";

/**
 * Sandbox-relative directory the remote repo is cloned into. Doubles as the
 * `runtimeRoot` the renderer treats as the filesystem root for a remote
 * workspace (mirrors `DaytonaWorkspaceRuntime`'s `workdir` default).
 */
export const REMOTE_SANDBOX_ROOT = "workspace";

export interface WorkspaceFilesystemManagerOptions {
	db: HostDb;
	/**
	 * Resolves the live `WorkspaceRuntime` for a remote workspace. Omitted on a
	 * local-only host; when absent, a remote workspace surfaces a clear error
	 * rather than silently serving an empty local path.
	 */
	resolveRemoteRuntime?: (workspaceId: string) => Promise<WorkspaceRuntime>;
}

export class WorkspaceFilesystemManager {
	private readonly db: HostDb;
	private readonly watcherManager = new FsWatcherManager();
	private readonly serviceCache = new Map<string, FsHostService>();
	private readonly remoteServiceCache = new Map<string, FsHostService>();
	private readonly resolveRemoteRuntime?: (
		workspaceId: string,
	) => Promise<WorkspaceRuntime>;

	constructor(options: WorkspaceFilesystemManagerOptions) {
		this.db = options.db;
		this.resolveRemoteRuntime = options.resolveRemoteRuntime;
	}

	resolveWorkspaceRoot(workspaceId: string): string {
		const workspace = this.db.query.workspaces
			.findFirst({ where: eq(workspaces.id, workspaceId) })
			.sync();

		if (!workspace) {
			throw new Error(`Workspace not found: ${workspaceId}`);
		}

		return workspace.worktreePath;
	}

	resolveProjectRoot(projectId: string): string {
		const project = this.db.query.projects
			.findFirst({ where: eq(projects.id, projectId) })
			.sync();

		if (!project) {
			throw new Error(`Project not found: ${projectId}`);
		}

		return project.repoPath;
	}

	getServiceForWorkspace(workspaceId: string): FsHostService {
		const workspace = this.db.query.workspaces
			.findFirst({ where: eq(workspaces.id, workspaceId) })
			.sync();

		if (!workspace) {
			throw new Error(`Workspace not found: ${workspaceId}`);
		}

		if (workspace.runtimeKind === "remote") {
			return this.getRemoteServiceForWorkspace(workspaceId);
		}

		return this.getServiceForRootPath(workspace.worktreePath);
	}

	/**
	 * Returns (and caches) a `DaytonaFsService` for a remote workspace. The
	 * service resolves the live runtime lazily inside each call, so this stays
	 * synchronous like the local path.
	 */
	private getRemoteServiceForWorkspace(workspaceId: string): FsHostService {
		const resolve = this.resolveRemoteRuntime;
		if (!resolve) {
			throw new Error(
				`No remote runtime resolver configured; cannot serve filesystem for remote workspace ${workspaceId}.`,
			);
		}
		let service = this.remoteServiceCache.get(workspaceId);
		if (!service) {
			service = new DaytonaFsService(
				() => resolve(workspaceId),
				workspaceId,
				REMOTE_SANDBOX_ROOT,
			);
			this.remoteServiceCache.set(workspaceId, service);
		}
		return service;
	}

	getServiceForProject(projectId: string): FsHostService {
		return this.getServiceForRootPath(this.resolveProjectRoot(projectId));
	}

	private getServiceForRootPath(rootPath: string): FsHostService {
		let service = this.serviceCache.get(rootPath);
		if (!service) {
			service = createFsHostService({
				rootPath,
				watcherManager: this.watcherManager,
			});
			this.serviceCache.set(rootPath, service);
			// Pre-warm search index so first search is instant
			getSearchIndex({ rootPath, includeHidden: false }).catch(() => {});
		}
		return service;
	}

	async close(): Promise<void> {
		this.serviceCache.clear();
		await Promise.all(
			Array.from(this.remoteServiceCache.values()).map((service) =>
				service.close().catch(() => {}),
			),
		);
		this.remoteServiceCache.clear();
		await this.watcherManager.close();
	}
}
