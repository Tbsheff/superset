import { generateFriendlyBranchName } from "@superset/shared/workspace-launch";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { workspaces } from "../../../../db/schema";
import { createDaytonaSdk } from "../../../../runtime/adapters/daytona/index";
import type { RuntimeInstanceRecord } from "../../../../runtime/adapters/daytona/types";
import {
	getRuntimeAdapter,
	type RuntimeAdapterDeps,
} from "../../../../runtime/registry/index";
import { RuntimeInstanceStore } from "../../../../runtime/store/index";
import type { HostServiceContext } from "../../../../types";
import type { LocalProject } from "./local-project";

/**
 * Remote workspaces have no on-disk worktree, but the host `workspaces` table
 * declares `worktree_path` NOT NULL. An empty string is the sentinel the
 * remote-aware read paths (Milestone-1 #10 `getDiff`, #11 push) key on:
 * `runtimeKind === "remote"` means "ignore worktreePath, resolve the runtime
 * from currentRuntimeId instead."
 */
const REMOTE_WORKTREE_SENTINEL = "";

/**
 * The runtime store + adapter the remote create flow drives. Kept as a seam so
 * unit tests inject a fake SDK/store/adapter and never touch Daytona or the
 * network. `store` is the concrete `RuntimeInstanceStore` (not the narrow
 * `DaytonaInstanceStore`) because resolving the persisted row id after
 * `createInstance` needs its `getByExternalId` read helper.
 */
export interface RemoteRuntime {
	store: Pick<RuntimeInstanceStore, "getByExternalId">;
	getAdapter: () => ReturnType<typeof getRuntimeAdapter>;
}

/**
 * Builds the production remote runtime from `ctx` + env: a real Daytona SDK, the
 * SQLite-backed `RuntimeInstanceStore`, and the scoped-token minter. Throws
 * CONFIG_MISSING (via `getRuntimeAdapter`) when any remote dependency is absent,
 * so a local-only host produces a clear error rather than a silent local
 * fallback.
 *
 * `env` is dynamically imported so loading this module (e.g. for the unit test,
 * which injects a fake runtime) never triggers `createEnv`'s `process.env`
 * validation — only an actual production remote create touches it.
 */
export async function buildRemoteRuntime(
	ctx: HostServiceContext,
): Promise<RemoteRuntime> {
	const { env } = await import("../../../../env");
	const store = new RuntimeInstanceStore(ctx.db);
	const deps: RuntimeAdapterDeps = {
		db: ctx.db,
		git: ctx.git,
		eventBus: ctx.eventBus,
		sdk: createDaytonaSdk(env),
		store,
		mintRepoScopedToken: ctx.mintRepoScopedToken,
	};
	return {
		store,
		getAdapter: () => getRuntimeAdapter("remote", deps),
	};
}

interface CreateRemoteWorkspaceArgs {
	ctx: HostServiceContext;
	localProject: LocalProject;
	id: string | undefined;
	name: string | undefined;
	branch: string | undefined;
	baseBranch?: string | undefined;
	taskId: string | undefined;
	hostPromise: Promise<{ machineId: string }>;
	runtime: RemoteRuntime;
}

type CloudWorkspace = NonNullable<
	Awaited<
		ReturnType<HostServiceContext["api"]["v2Workspace"]["getFromHost"]["query"]>
	>
>;

export interface CreateRemoteWorkspaceResult {
	workspace: CloudWorkspace;
	runtimeInstanceId: string;
	externalId: string;
}

/**
 * Creates a remote (Daytona) workspace WITHOUT a local worktree. Mirrors the
 * cloud+local registration of the local create path, then provisions the sandbox
 * through the runtime adapter and records the live runtime instance on the
 * workspace row (`runtimeKind="remote"`, `currentRuntimeId=<row id>`).
 *
 * The clone source is the project's GitHub https url (`repoUrl`), not the local
 * `repoPath` — the sandbox clones over the network, so a host-local path would
 * be meaningless and `parseRepoCoordinates` would reject it.
 */
export async function createRemoteWorkspace(
	args: CreateRemoteWorkspaceArgs,
): Promise<CreateRemoteWorkspaceResult> {
	const { ctx, localProject, runtime } = args;

	const cloneUrl = localProject.repoUrl;
	if (!cloneUrl) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Remote workspaces require the project's GitHub repository URL; " +
				"this project has no repoUrl recorded.",
		});
	}

	// Resolve the adapter up front so a misconfigured host fails before any
	// cloud/local row is written (no orphan rows on CONFIG_MISSING).
	const adapter = runtime.getAdapter();

	const branch = args.branch?.trim() || generateFriendlyBranchName();
	const name = args.name ?? branch;

	let host: { machineId: string };
	try {
		host = await args.hostPromise;
	} catch (err) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Failed to register host: ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	const cloudRow = await ctx.api.v2Workspace.create.mutate({
		organizationId: ctx.organizationId,
		projectId: localProject.id,
		name,
		branch,
		hostId: host.machineId,
		taskId: args.taskId,
		id: args.id,
		runtimeKind: "remote",
	});
	if (!cloudRow) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Cloud workspace create returned no row",
		});
	}

	const rollbackCloud = async () => {
		await ctx.api.v2Workspace.delete
			.mutate({ id: cloudRow.id })
			.catch((cleanupErr) => {
				console.warn(
					"[createRemoteWorkspace] failed to rollback cloud workspace",
					{ workspaceId: cloudRow.id, err: cleanupErr },
				);
			});
	};

	try {
		ctx.db
			.insert(workspaces)
			.values({
				id: cloudRow.id,
				projectId: localProject.id,
				worktreePath: REMOTE_WORKTREE_SENTINEL,
				branch,
				runtimeKind: "remote",
			})
			.run();
	} catch (err) {
		await rollbackCloud();
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Failed to persist workspace locally: ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	let handle: { externalId: string };
	try {
		handle = await adapter.createInstance({
			role: "workspace",
			workspaceId: cloudRow.id,
			repo: {
				cloneUrl,
				ref: args.baseBranch ?? "",
				createBranch: branch,
			},
		});
	} catch (err) {
		ctx.db.delete(workspaces).where(eq(workspaces.id, cloudRow.id)).run();
		await rollbackCloud();
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Failed to provision remote runtime: ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	const record: RuntimeInstanceRecord | undefined =
		runtime.store.getByExternalId(handle.externalId);
	if (!record) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Remote runtime ${handle.externalId} was provisioned but no runtime_instances row was persisted`,
		});
	}

	ctx.db
		.update(workspaces)
		.set({ runtimeKind: "remote", currentRuntimeId: record.id })
		.where(eq(workspaces.id, cloudRow.id))
		.run();

	return {
		workspace: cloudRow,
		runtimeInstanceId: record.id,
		externalId: handle.externalId,
	};
}
