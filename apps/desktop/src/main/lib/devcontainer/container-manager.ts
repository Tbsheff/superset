import type { Client } from "ssh2";
import { sshExec } from "./ssh-exec";
import type { ContainerInfo, ProjectPaths } from "./types";

export interface DevcontainerUpResult {
	containerId: string;
	remoteUser: string;
}

/**
 * Clone a git repo on the remote host.
 * Supports both SSH URLs (with agent forwarding) and HTTPS URLs (with token).
 */
export async function cloneRepo(
	client: Client,
	repoUrl: string,
	paths: ProjectPaths,
	opts?: { token?: string; branch?: string },
): Promise<void> {
	// Create directory structure
	await sshExec(client, `mkdir -p ${paths.baseDir} ${paths.worktreesDir}`);

	// Check if repo already exists
	const exists = await sshExec(client, `test -d ${paths.repoDir}/.git`);
	if (exists.code === 0) return; // Already cloned

	// Always disable interactive credential prompts — fail fast instead of hanging
	const envPrefix = "GIT_TERMINAL_PROMPT=0";

	let cloneCmd: string;
	if (opts?.token && repoUrl.startsWith("https://")) {
		// HTTPS with token — inject credentials directly in URL
		const tokenUrl = repoUrl.replace(
			"https://",
			`https://x-access-token:${opts.token}@`,
		);
		cloneCmd = `${envPrefix} git clone --no-checkout ${tokenUrl} ${paths.repoDir}`;
	} else {
		// SSH URL or HTTPS without auth — rely on agent forwarding or existing credentials
		cloneCmd = `${envPrefix} git clone --no-checkout ${repoUrl} ${paths.repoDir}`;
	}

	const clone = await sshExec(client, cloneCmd, { timeout: 60_000 });
	if (clone.code !== 0) {
		const stderr = clone.stderr.toLowerCase();
		if (
			stderr.includes("authentication") ||
			stderr.includes("could not read") ||
			clone.code === 128
		) {
			throw new Error(
				"Git authentication failed. Ensure 'gh auth login' is run locally, or use an SSH URL.",
			);
		}
		throw new Error(`Git clone failed: ${clone.stderr.trim()}`);
	}

	// Checkout default branch
	const branch = opts?.branch ?? "main";
	const checkout = await sshExec(
		client,
		`cd ${paths.repoDir} && git checkout ${branch}`,
		{ timeout: 30_000 },
	);
	if (checkout.code !== 0) {
		// Try 'master' as fallback
		const masterCheckout = await sshExec(
			client,
			`cd ${paths.repoDir} && git checkout master`,
			{ timeout: 30_000 },
		);
		if (masterCheckout.code !== 0) {
			throw new Error(`Git checkout failed: ${checkout.stderr.trim()}`);
		}
	}
}

/**
 * Run `devcontainer up` to build/start the container.
 * Returns container ID and remote user.
 */
export async function devcontainerUp(
	client: Client,
	paths: ProjectPaths,
	projectId: string,
	opts?: {
		hasExistingConfig: boolean;
		onProgress?: (message: string) => void;
	},
): Promise<DevcontainerUpResult> {
	const args = [
		"devcontainer up",
		`--workspace-folder ${paths.repoDir}`,
		`--id-label superset.project=${projectId}`,
		"--log-format json",
	];

	// If repo has its own devcontainer.json, add worktrees as additional mount
	// (don't override their workspaceMount)
	if (opts?.hasExistingConfig) {
		args.push(
			`--mount type=bind,source=${paths.worktreesDir},target=/workspaces/worktrees`,
		);
	}

	const cmd = args.join(" ");
	console.log("[container-manager] devcontainerUp cmd:", cmd);
	const result = await sshExec(client, cmd, { timeout: 600_000 });

	if (result.code !== 0) {
		throw new Error(
			`devcontainer up failed: ${result.stderr.trim().slice(0, 500)}`,
		);
	}

	// Parse container ID from JSON output
	// devcontainer up outputs JSON to stdout, progress to stderr
	const containerId = parseContainerId(result.stdout);
	if (!containerId) {
		throw new Error("Could not parse container ID from devcontainer up output");
	}

	// Read remote user from config
	const remoteUser = await readRemoteUser(client, paths.repoDir);

	return { containerId, remoteUser };
}

/**
 * Get container status by ID.
 */
export async function inspectContainer(
	client: Client,
	containerId: string,
): Promise<ContainerInfo> {
	const result = await sshExec(
		client,
		`docker inspect --format '{{.State.Status}}' ${containerId} 2>/dev/null`,
		{ timeout: 10_000 },
	);

	if (result.code !== 0) {
		return { containerId, status: "not_found" };
	}

	const status = result.stdout.trim();
	switch (status) {
		case "running":
			return { containerId, status: "running" };
		case "exited":
		case "dead":
			return { containerId, status: "exited" };
		case "paused":
			return { containerId, status: "paused" };
		default:
			return { containerId, status: "not_found" };
	}
}

/**
 * Find container by project label.
 * Used for reconciliation when we don't have a stored container ID.
 */
export async function findContainerByLabel(
	client: Client,
	projectId: string,
): Promise<ContainerInfo | null> {
	const result = await sshExec(
		client,
		`docker ps -a --filter "label=superset.project=${projectId}" --format "{{.ID}}\t{{.State}}" | head -1`,
		{ timeout: 10_000 },
	);

	if (result.code !== 0 || !result.stdout.trim()) {
		return null;
	}

	const [id, state] = result.stdout.trim().split("\t");
	if (!id) return null;

	const statusMap: Record<string, ContainerInfo["status"]> = {
		running: "running",
		exited: "exited",
		paused: "paused",
		dead: "exited",
	};

	return {
		containerId: id,
		status: statusMap[state ?? ""] ?? "not_found",
	};
}

/**
 * Stop a container.
 */
export async function stopContainer(
	client: Client,
	containerId: string,
): Promise<void> {
	await sshExec(client, `docker stop ${containerId}`, { timeout: 30_000 });
}

/**
 * Start a previously stopped container.
 * Use `devcontainer up` for idempotent start (handles lifecycle hooks).
 */
export async function startContainer(
	client: Client,
	paths: ProjectPaths,
	projectId: string,
): Promise<string> {
	const result = await devcontainerUp(client, paths, projectId);
	return result.containerId;
}

/**
 * Destroy container and clean up project files.
 */
export async function destroyContainer(
	client: Client,
	containerId: string | undefined,
	paths: ProjectPaths,
	projectId: string,
): Promise<void> {
	// Remove container by ID if known
	if (containerId) {
		await sshExec(client, `docker rm -f ${containerId}`, {
			timeout: 15_000,
		}).catch(() => {});
	}

	// Also remove by label (in case container ID is stale)
	await sshExec(
		client,
		`docker ps -a --filter "label=superset.project=${projectId}" -q | xargs -r docker rm -f`,
		{ timeout: 15_000 },
	).catch(() => {});

	// Remove project directory
	await sshExec(client, `rm -rf ${paths.baseDir}`, { timeout: 15_000 });
}

/**
 * Create a git worktree inside the container.
 * CRITICAL: Must run inside container (docker exec) so .git paths are container-relative.
 */
export async function createWorktree(
	client: Client,
	containerId: string,
	branch: string,
	baseBranch: string,
): Promise<void> {
	const cmd = [
		`docker exec -e GIT_TERMINAL_PROMPT=0 ${containerId} bash -c '`,
		"cd /workspaces/repo &&",
		"git fetch origin &&",
		`git worktree add /workspaces/worktrees/${branch} -b ${branch} origin/${baseBranch}`,
		"'",
	].join(" ");

	const result = await sshExec(client, cmd, { timeout: 60_000 });
	if (result.code !== 0) {
		// Branch may already exist — try without -b
		const retry = await sshExec(
			client,
			`docker exec -e GIT_TERMINAL_PROMPT=0 ${containerId} bash -c 'cd /workspaces/repo && git fetch origin && git worktree add /workspaces/worktrees/${branch} ${branch}'`,
			{ timeout: 60_000 },
		);
		if (retry.code !== 0) {
			throw new Error(
				`Failed to create worktree for ${branch}: ${result.stderr.trim()}`,
			);
		}
	}
}

/**
 * Remove a git worktree.
 */
export async function removeWorktree(
	client: Client,
	containerId: string,
	branch: string,
): Promise<void> {
	await sshExec(
		client,
		`docker exec ${containerId} bash -c 'cd /workspaces/repo && git worktree remove /workspaces/worktrees/${branch} --force'`,
		{ timeout: 30_000 },
	).catch(() => {});

	// Prune stale worktrees
	await sshExec(
		client,
		`docker exec ${containerId} bash -c 'cd /workspaces/repo && git worktree prune'`,
		{ timeout: 10_000 },
	).catch(() => {});
}

/**
 * Prune stale worktree references (run on startup).
 */
export async function pruneWorktrees(
	client: Client,
	containerId: string,
): Promise<void> {
	await sshExec(
		client,
		`docker exec ${containerId} bash -c 'cd /workspaces/repo && git worktree prune'`,
		{ timeout: 10_000 },
	).catch(() => {});
}

// --- Internal helpers ---

function parseContainerId(stdout: string): string | null {
	// devcontainer up outputs JSON to stdout, one line at a time
	// The final line typically contains the result with containerId
	const lines = stdout.trim().split("\n").reverse();
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (parsed.containerId) return parsed.containerId;
			// Sometimes nested under outcome
			if (parsed.outcome === "success" && parsed.containerId)
				return parsed.containerId;
		} catch {}
	}
	return null;
}

async function readRemoteUser(
	client: Client,
	repoDir: string,
): Promise<string> {
	// Use devcontainer read-configuration to get the resolved remote user
	const result = await sshExec(
		client,
		`devcontainer read-configuration --workspace-folder ${repoDir} 2>/dev/null`,
		{ timeout: 15_000 },
	);

	if (result.code === 0) {
		try {
			const config = JSON.parse(result.stdout);
			if (config.configuration?.remoteUser)
				return config.configuration.remoteUser;
			if (config.mergedConfiguration?.remoteUser)
				return config.mergedConfiguration.remoteUser;
		} catch {
			// Fall through to default
		}
	}

	return "vscode"; // Default for devcontainers/base image
}
