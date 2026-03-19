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

/**
 * Run all prerequisite checks on a remote host.
 * Reports individual results so the UI can show granular progress.
 */
export async function checkPrerequisites(
	client: Client,
	hostname: string,
): Promise<PrerequisiteReport> {
	const report: PrerequisiteReport = {
		docker: { passed: false },
		dockerPermissions: { passed: false },
		dockerResponsive: { passed: false },
		nodeJs: { passed: false },
		devcontainerCli: { passed: false },
		diskSpace: { passed: false },
		allPassed: false,
	};

	// 1. Docker installed
	const dockerVersion = await sshExec(
		client,
		"docker version --format '{{.Server.Version}}'",
		{ timeout: 10_000 },
	);
	if (dockerVersion.code !== 0) {
		const stderr = dockerVersion.stderr.toLowerCase();
		if (stderr.includes("not found") || stderr.includes("no such file")) {
			report.docker = {
				passed: false,
				error: `Docker is not installed on ${hostname}`,
				hint: "Install Docker: https://docs.docker.com/engine/install/",
			};
		} else if (stderr.includes("cannot connect") || stderr.includes("daemon")) {
			report.docker = { passed: true }; // Docker exists but daemon not running — caught in step 3
			report.dockerResponsive = {
				passed: false,
				error: "Docker daemon not running",
				hint: "Start Docker: `sudo systemctl start docker` or open Docker Desktop",
			};
		} else {
			report.docker = {
				passed: false,
				error: `Docker check failed: ${dockerVersion.stderr.trim()}`,
			};
		}
	} else {
		report.docker = { passed: true };
	}

	// 2. Docker permissions
	if (report.docker.passed) {
		const dockerInfo = await sshExec(
			client,
			"docker info --format '{{.SecurityOptions}}'",
			{ timeout: 10_000 },
		);
		if (dockerInfo.stderr.toLowerCase().includes("permission denied")) {
			report.dockerPermissions = {
				passed: false,
				error: "User cannot access Docker",
				hint: "Run: `sudo usermod -aG docker $USER` then re-login",
			};
		} else {
			report.dockerPermissions = { passed: true };
		}
	}

	// 3. Docker responsive
	if (report.docker.passed && report.dockerPermissions.passed) {
		const dockerPs = await sshExec(client, "docker ps -q", { timeout: 5_000 });
		if (dockerPs.code !== 0) {
			report.dockerResponsive = {
				passed: false,
				error: "Docker daemon not responding",
				hint: "Start Docker: `sudo systemctl start docker` or open Docker Desktop",
			};
		} else {
			report.dockerResponsive = { passed: true };
		}
	}

	// 4. Node.js
	const nodeVersion = await sshExec(client, "node --version", {
		timeout: 5_000,
	});
	if (nodeVersion.code === 0) {
		const version = nodeVersion.stdout.trim().replace(/^v/, "");
		const major = Number.parseInt(version.split(".")[0] ?? "0", 10);
		if (major >= 18) {
			report.nodeJs = { passed: true };
		} else {
			report.nodeJs = {
				passed: false,
				error: `Node.js ${version} is too old (need >= 18)`,
				hint: "Update Node.js: https://nodejs.org/",
			};
		}
	} else {
		report.nodeJs = {
			passed: false,
			error: "Node.js not installed",
			hint: "Install Node.js: `brew install node` or `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -`",
		};
	}

	// 5. devcontainer CLI
	const dcVersion = await sshExec(client, "devcontainer --version", {
		timeout: 5_000,
	});
	if (dcVersion.code === 0) {
		report.devcontainerCli = { passed: true };
	} else if (report.nodeJs.passed) {
		// Try auto-install
		report.devcontainerCli = await autoInstallDevcontainerCli(client);
	} else {
		report.devcontainerCli = {
			passed: false,
			error: "devcontainer CLI not installed (requires Node.js)",
			hint: "Install Node.js first, then: `npm install -g @devcontainers/cli`",
		};
	}

	// 6. Disk space — use `df` with portable flags (macOS doesn't support -BG)
	const dfResult = await sshExec(
		client,
		"df -k ~ | tail -1 | awk '{print $4}'",
		{ timeout: 5_000 },
	);
	if (dfResult.code === 0) {
		const availKb = Number.parseInt(dfResult.stdout.trim(), 10);
		const availGb = availKb / 1_048_576;
		if (availGb < 5) {
			report.diskSpace = {
				passed: false,
				error: `Only ${availGb.toFixed(1)}GB free (need at least 5GB)`,
				hint: "Free disk space: `docker system prune -a`",
			};
		} else if (availGb < 20) {
			report.diskSpace = {
				passed: true, // warn but don't block
				hint: `Low disk space: ${availGb.toFixed(1)}GB free. Consider freeing space.`,
			};
		} else {
			report.diskSpace = { passed: true };
		}
	} else {
		report.diskSpace = { passed: true }; // Can't check — don't block
	}

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
