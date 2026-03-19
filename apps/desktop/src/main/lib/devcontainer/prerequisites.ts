import type { Client } from "ssh2";
import { sshExec } from "./ssh-exec";

export interface PrerequisiteResult {
	passed: boolean;
	error?: string;
	/** Human-readable hint for the user */
	hint?: string;
}

export interface PrerequisiteReport {
	docker: PrerequisiteResult;
	dockerPermissions: PrerequisiteResult;
	dockerResponsive: PrerequisiteResult;
	nodeJs: PrerequisiteResult;
	devcontainerCli: PrerequisiteResult;
	diskSpace: PrerequisiteResult;
	/** True if all critical checks passed */
	allPassed: boolean;
}

async function checkDocker(
	client: Client,
	hostname: string,
): Promise<PrerequisiteResult> {
	const result = await sshExec(
		client,
		"docker version --format '{{.Server.Version}}'",
		{ timeout: 10_000 },
	);
	if (result.code !== 0) {
		const stderr = result.stderr.toLowerCase();
		if (stderr.includes("not found") || stderr.includes("no such file")) {
			return {
				passed: false,
				error: `Docker is not installed on ${hostname}`,
				hint: "Install Docker: https://docs.docker.com/engine/install/",
			};
		}
		return {
			passed: false,
			error: `Docker check failed: ${result.stderr.trim()}`,
		};
	}
	return { passed: true };
}

async function checkDockerPermissions(
	client: Client,
): Promise<PrerequisiteResult> {
	const result = await sshExec(
		client,
		"docker info --format '{{.SecurityOptions}}'",
		{ timeout: 10_000 },
	);
	if (result.stderr.toLowerCase().includes("permission denied")) {
		return {
			passed: false,
			error: "User cannot access Docker",
			hint: "Run: `sudo usermod -aG docker $USER` then re-login",
		};
	}
	// docker info also verifies the daemon is responsive
	if (result.code !== 0) {
		return {
			passed: false,
			error: "Docker daemon not running",
			hint: "Start Docker: `sudo systemctl start docker` or open Docker Desktop",
		};
	}
	return { passed: true };
}

async function checkNodeJs(client: Client): Promise<PrerequisiteResult> {
	const result = await sshExec(client, "node --version", { timeout: 5_000 });
	if (result.code !== 0) {
		return {
			passed: false,
			error: "Node.js not installed",
			hint: "Install Node.js: `brew install node` or `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -`",
		};
	}
	const version = result.stdout.trim().replace(/^v/, "");
	const major = Number.parseInt(version.split(".")[0] ?? "0", 10);
	if (major >= 18) {
		return { passed: true };
	}
	return {
		passed: false,
		error: `Node.js ${version} is too old (need >= 18)`,
		hint: "Update Node.js: https://nodejs.org/",
	};
}

async function checkDiskSpace(client: Client): Promise<PrerequisiteResult> {
	const result = await sshExec(client, "df -k ~ | tail -1 | awk '{print $4}'", {
		timeout: 5_000,
	});
	if (result.code !== 0) {
		return { passed: true }; // Can't check — don't block
	}
	const availKb = Number.parseInt(result.stdout.trim(), 10);
	const availGb = availKb / 1_048_576;
	if (availGb < 5) {
		return {
			passed: false,
			error: `Only ${availGb.toFixed(1)}GB free (need at least 5GB)`,
			hint: "Free disk space: `docker system prune -a`",
		};
	}
	if (availGb < 20) {
		return {
			passed: true, // warn but don't block
			hint: `Low disk space: ${availGb.toFixed(1)}GB free. Consider freeing space.`,
		};
	}
	return { passed: true };
}

async function checkDevcontainerCli(
	client: Client,
	nodeJsPassed: boolean,
): Promise<PrerequisiteResult> {
	const result = await sshExec(client, "devcontainer --version", {
		timeout: 5_000,
	});
	if (result.code === 0) {
		return { passed: true };
	}
	if (nodeJsPassed) {
		return autoInstallDevcontainerCli(client);
	}
	return {
		passed: false,
		error: "devcontainer CLI not installed (requires Node.js)",
		hint: "Install Node.js first, then: `npm install -g @devcontainers/cli`",
	};
}

/**
 * Run all prerequisite checks on a remote host.
 * Reports individual results so the UI can show granular progress.
 *
 * Checks are parallelized where possible:
 *   Batch 1 (parallel): Docker installed, Node.js, Disk space
 *   Batch 2 (after Docker passes): Docker permissions (docker info covers daemon responsiveness)
 *   Batch 3 (after Node passes): devcontainer CLI
 */
export async function checkPrerequisites(
	client: Client,
	hostname: string,
): Promise<PrerequisiteReport> {
	// Batch 1: independent checks in parallel
	const [dockerResult, nodeResult, diskResult] = await Promise.all([
		checkDocker(client, hostname),
		checkNodeJs(client),
		checkDiskSpace(client),
	]);

	const report: PrerequisiteReport = {
		docker: dockerResult,
		dockerPermissions: { passed: false },
		dockerResponsive: { passed: false },
		nodeJs: nodeResult,
		devcontainerCli: { passed: false },
		diskSpace: diskResult,
		allPassed: false,
	};

	// Batch 2 & 3: run in parallel — each gated on its Batch 1 dependency
	const [dockerPermissionsResult, devcontainerResult] = await Promise.all([
		report.docker.passed
			? checkDockerPermissions(client)
			: Promise.resolve<PrerequisiteResult>({ passed: false }),
		checkDevcontainerCli(client, report.nodeJs.passed),
	]);

	report.dockerPermissions = dockerPermissionsResult;
	// docker info (in checkDockerPermissions) already verifies daemon responsiveness
	report.dockerResponsive = report.docker.passed
		? dockerPermissionsResult
		: { passed: false };
	report.devcontainerCli = devcontainerResult;

	report.allPassed =
		report.docker.passed &&
		report.dockerPermissions.passed &&
		report.dockerResponsive.passed &&
		report.devcontainerCli.passed;

	return report;
}

async function autoInstallDevcontainerCli(
	client: Client,
): Promise<PrerequisiteResult> {
	// Try without sudo first
	const install = await sshExec(
		client,
		"npm install -g @devcontainers/cli@latest",
		{ timeout: 60_000 },
	);
	if (install.code === 0) {
		return { passed: true };
	}

	// Try with sudo
	const sudoInstall = await sshExec(
		client,
		"sudo npm install -g @devcontainers/cli@latest",
		{ timeout: 60_000 },
	);
	if (sudoInstall.code === 0) {
		return { passed: true };
	}

	return {
		passed: false,
		error: "Failed to auto-install devcontainer CLI",
		hint: "Install manually: `npm install -g @devcontainers/cli`",
	};
}
