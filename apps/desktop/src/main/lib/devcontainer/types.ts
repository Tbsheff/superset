import type { Client } from "ssh2";

export interface ContainerInfo {
	containerId: string;
	status: "running" | "exited" | "paused" | "not_found";
	image?: string;
}

export interface DevcontainerConfig {
	/** Whether the repo already has a devcontainer.json */
	hasExisting: boolean;
	/** Path to devcontainer.json on the remote host */
	configPath: string;
	/** Remote user inside the container (default: "vscode") */
	remoteUser: string;
	/** Workspace folder inside the container */
	workspaceFolder: string;
}

export interface ProjectPaths {
	/** Base directory on remote: ~/superset-projects/<slug> */
	baseDir: string;
	/** Repo clone path: ~/superset-projects/<slug>/repo */
	repoDir: string;
	/** Worktrees parent: ~/superset-projects/<slug>/worktrees */
	worktreesDir: string;
}

export interface SessionOptions {
	containerId: string;
	workDir: string;
	remoteUser: string;
	cols: number;
	rows: number;
	envVars: Record<string, string>;
}

export function slugifyName(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "project"
	);
}

export function getProjectPaths(slug: string): ProjectPaths {
	const baseDir = `~/superset-projects/${slug}`;
	return {
		baseDir,
		repoDir: `${baseDir}/repo`,
		worktreesDir: `${baseDir}/worktrees`,
	};
}

// Re-export Client for use across the devcontainer module
export type { Client };
