import type { SandboxState } from "@superset/local-db";
import { remoteHosts, workspaces, worktrees } from "@superset/local-db";
import { eq } from "drizzle-orm";
import {
	cloneRepo,
	createWorktree,
	devcontainerUp,
} from "main/lib/devcontainer/container-manager";
import {
	detectExistingConfig,
	generateDefaultConfig,
} from "main/lib/devcontainer/default-config";
import { checkPrerequisites } from "main/lib/devcontainer/prerequisites";
import { sshExec } from "main/lib/devcontainer/ssh-exec";
import { getStateMachine } from "main/lib/devcontainer/state-machine";
import { getProjectPaths, slugifyName } from "main/lib/devcontainer/types";
import { localDb } from "main/lib/local-db";
import { workspaceInitManager } from "main/lib/workspace-init-manager";
import { getSshConnectionManager } from "main/lib/workspace-runtime/ssh-connection-manager";
import type { WorkspaceInitStep } from "shared/types/workspace-init";
import { execWithShellEnv } from "./shell-env";

export interface RemoteInitParams {
	workspaceId: string;
	projectId: string;
	remoteHostId: string;
	branch: string;
	/** Slug used for remote directory naming (derived from project name if omitted) */
	projectSlug?: string;
	projectName?: string;
	repoUrl?: string;
	baseBranch?: string;
	defaultBranch?: string;
	githubToken?: string;
	/** If provided, skip cloning and use this pre-existing remote path as the repo directory */
	remoteRepoPath?: string;
	/** Persist sandbox state to DB */
	persistState?: (state: SandboxState) => Promise<void>;
}

const noopPersist = async (_state: SandboxState): Promise<void> => {};

export async function initRemoteWorkspace(
	params: RemoteInitParams,
): Promise<void> {
	const {
		workspaceId,
		projectId,
		projectSlug,
		projectName = projectId,
		remoteHostId,
		repoUrl,
		branch,
		baseBranch,
		defaultBranch,
		githubToken: githubTokenParam,
		remoteRepoPath,
		persistState = noopPersist,
	} = params;

	const slug = projectSlug || slugifyName(projectName) || projectId;

	let paths = getProjectPaths(slug);

	// Resolve GitHub token for HTTPS clones
	let githubToken = githubTokenParam;
	if (!githubToken && repoUrl?.startsWith("https://")) {
		try {
			const { stdout } = await execWithShellEnv("gh", ["auth", "token"]);
			githubToken = stdout.trim() || undefined;
		} catch {
			// gh not authenticated — clone will fail if repo is private
		}
	}
	const stateMachine = getStateMachine(projectId, persistState);

	const emitProgress = (step: WorkspaceInitStep, message: string) => {
		workspaceInitManager.updateProgress(workspaceId, step, message);
	};

	try {
		// 1. Connect SSH
		emitProgress("connecting_ssh", "Connecting to remote host...");
		await stateMachine.startProvisioning(
			"checking_prerequisites",
			"Connecting to remote host...",
		);

		const manager = getSshConnectionManager();

		// Ensure SSH connection is established
		let client = manager.getConnection(remoteHostId);
		if (!client) {
			// Need to connect — look up host config from DB
			const hostConfig = localDb
				.select()
				.from(remoteHosts)
				.where(eq(remoteHosts.id, remoteHostId))
				.get();
			if (!hostConfig) {
				throw new Error(`Remote host ${remoteHostId} not found`);
			}
			await manager.connect({
				id: hostConfig.id,
				hostname: hostConfig.hostname ?? "",
				port: hostConfig.port ?? 22,
				username: hostConfig.username ?? "",
				authMethod: hostConfig.authMethod as "key" | "agent" | "password",
				privateKeyPath: hostConfig.privateKeyPath ?? undefined,
			});
			client = manager.getConnection(remoteHostId);
			if (!client) {
				throw new Error("Failed to establish SSH connection");
			}
		}

		// 2. Check prerequisites
		emitProgress("checking_docker", "Checking Docker availability...");
		await stateMachine.updateStep(
			"checking_prerequisites",
			"Checking Docker...",
		);

		const prereqs = await checkPrerequisites(client, remoteHostId);
		if (!prereqs.allPassed) {
			const errors = (
				Object.entries(prereqs) as Array<
					[string, { passed?: boolean; error?: string } | boolean]
				>
			)
				.filter(
					([key, val]) =>
						key !== "allPassed" &&
						typeof val === "object" &&
						val !== null &&
						!val.passed,
				)
				.map(([, val]) => (val as { error?: string }).error)
				.filter(Boolean);
			throw new Error(`Prerequisites failed: ${errors.join("; ")}`);
		}

		// 3. Clone repo or use existing path
		let effectiveRepoDir: string;
		if (remoteRepoPath) {
			// User already has repo cloned — use their path directly
			effectiveRepoDir = remoteRepoPath;
			const worktreesDir = `${remoteRepoPath}/../worktrees`;
			await sshExec(client, `mkdir -p ${worktreesDir}`);
			paths = {
				baseDir: `${remoteRepoPath}/..`,
				repoDir: remoteRepoPath,
				worktreesDir,
			};
		} else {
			emitProgress("cloning_repo", "Cloning repository...");
			await stateMachine.updateStep("cloning_repo", "Cloning repository...");

			if (!repoUrl && !remoteRepoPath) {
				throw new Error(
					"Either repoUrl or remoteRepoPath is required for remote workspace initialization",
				);
			}

			await cloneRepo(client, repoUrl!, paths, {
				token: githubToken,
				branch: defaultBranch ?? "main",
			});
			effectiveRepoDir = paths.repoDir;
		}

		// 4. Ensure devcontainer.json
		emitProgress("building_devcontainer", "Preparing devcontainer...");
		await stateMachine.updateStep(
			"generating_config",
			"Ensuring devcontainer config...",
		);

		const existingConfig = await detectExistingConfig(client, effectiveRepoDir);
		if (!existingConfig) {
			await generateDefaultConfig(client, {
				projectName,
				repoDir: effectiveRepoDir,
			});
		}

		// 5. devcontainer up
		emitProgress("starting_container", "Starting container...");
		await stateMachine.updateStep(
			"building_container",
			"Building devcontainer...",
		);

		const { containerId } = await devcontainerUp(client, paths, projectId, {
			hasExistingConfig: existingConfig !== null,
		});

		await stateMachine.updateStep(
			"running_lifecycle",
			"Running lifecycle commands...",
		);

		// 6. Create worktree (if not on default branch)
		const resolvedDefault = defaultBranch ?? "main";
		const isDefaultBranch = branch === resolvedDefault || branch === "master";
		if (!isDefaultBranch) {
			emitProgress("creating_worktree", "Creating worktree...");
			await stateMachine.updateStep(
				"creating_worktree",
				`Creating worktree for ${branch}...`,
			);
			await createWorktree(
				client,
				containerId,
				branch,
				baseBranch ?? resolvedDefault,
			);
		}

		// 7. Mark ready
		emitProgress("finalizing", "Finalizing...");
		await stateMachine.markReady(containerId);

		// Write gitStatus to unblock the UI's hasIncompleteInit check
		const wsRecord = localDb
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.get();
		if (wsRecord?.worktreeId) {
			localDb
				.update(worktrees)
				.set({
					gitStatus: {
						branch,
						needsRebase: false,
						ahead: 0,
						behind: 0,
						lastRefreshed: Date.now(),
					},
				})
				.where(eq(worktrees.id, wsRecord.worktreeId))
				.run();
		}

		emitProgress("ready", "Ready");
		workspaceInitManager.finalizeJob(workspaceId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await stateMachine.markError(message, undefined, true).catch(() => {});
		workspaceInitManager.updateProgress(
			workspaceId,
			"failed",
			message,
			message,
		);
		throw error;
	}
}
