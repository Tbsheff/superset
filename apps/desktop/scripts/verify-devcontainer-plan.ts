#!/usr/bin/env bun

/**
 * verify-devcontainer-plan.ts
 *
 * Verifies 6 critical assumptions from the devcontainer plan against a real remote host.
 *
 * Usage:
 *   bun apps/desktop/scripts/verify-devcontainer-plan.ts \
 *     --host 192.168.1.100 --username tyler --auth agent
 *
 *   SSH_HOST=192.168.1.100 SSH_USER=tyler SSH_AUTH=agent \
 *     bun apps/desktop/scripts/verify-devcontainer-plan.ts
 *
 * Auth options:
 *   agent    - use SSH agent (default)
 *   key      - use --key-path or SSH_KEY_PATH
 *   password - use --password or SSH_PASSWORD
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Client } from "ssh2";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
	options: {
		host: { type: "string" },
		port: { type: "string" },
		username: { type: "string" },
		auth: { type: "string" },
		"key-path": { type: "string" },
		password: { type: "string" },
		"cleanup-only": { type: "boolean", default: false },
	},
	strict: false,
});

const host = args.host ?? process.env.SSH_HOST;
const port = Number(args.port ?? process.env.SSH_PORT ?? "22");
const username = args.username ?? process.env.SSH_USER ?? process.env.USER;
const authMethod = (args.auth ?? process.env.SSH_AUTH ?? "agent") as
	| "agent"
	| "key"
	| "password";
const keyPath = args["key-path"] ?? process.env.SSH_KEY_PATH;
const password = args.password ?? process.env.SSH_PASSWORD;
const cleanupOnly = args["cleanup-only"] ?? false;

if (!host) {
	console.error(
		"Error: --host or SSH_HOST is required.\n\nUsage:\n  bun apps/desktop/scripts/verify-devcontainer-plan.ts --host <ip> --username <user> --auth agent|key|password",
	);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const PASS = `${GREEN}\u2713${RESET}`;
const FAIL = `${RED}\u2717${RESET}`;
const SKIP = `${YELLOW}\u2298${RESET}`;

// ---------------------------------------------------------------------------
// SSH helpers
// ---------------------------------------------------------------------------

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

function connect(): Promise<Client> {
	return new Promise((resolve, reject) => {
		const client = new Client();

		const config: Record<string, unknown> = {
			host,
			port,
			username,
			readyTimeout: 15_000,
		};

		switch (authMethod) {
			case "agent":
				config.agent = process.env.SSH_AUTH_SOCK;
				config.agentForward = true;
				break;
			case "key":
				if (!keyPath) {
					reject(new Error("--key-path or SSH_KEY_PATH required for key auth"));
					return;
				}
				config.privateKey = readFileSync(keyPath);
				break;
			case "password":
				if (!password) {
					reject(
						new Error("--password or SSH_PASSWORD required for password auth"),
					);
					return;
				}
				config.password = password;
				break;
		}

		client
			.on("ready", () => resolve(client))
			.on("error", (err) => reject(err))
			.connect(config as any);
	});
}

interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

function sshExec(
	client: Client,
	cmd: string,
	opts?: { pty?: boolean; timeout?: number; raw?: boolean },
): Promise<ExecResult> {
	const timeout = opts?.timeout ?? 120_000;
	// Wrap in login shell to ensure PATH includes Docker, nvm, etc.
	// Skip wrapping if raw is true (for commands that already handle this)
	const wrappedCmd = opts?.raw ? cmd : `bash -l -c ${shellQuote(cmd)}`;
	return new Promise((resolve, reject) => {
		const execOpts = opts?.pty ? { pty: true } : {};
		const timer = setTimeout(() => {
			reject(
				new Error(`Command timed out after ${timeout}ms: ${cmd.slice(0, 80)}`),
			);
		}, timeout);

		client.exec(wrappedCmd, execOpts, (err, stream) => {
			if (err) {
				clearTimeout(timer);
				reject(err);
				return;
			}

			let stdout = "";
			let stderr = "";

			stream.on("data", (data: Buffer) => {
				stdout += data.toString();
			});
			stream.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString();
			});
			stream.on("close", (code: number) => {
				clearTimeout(timer);
				resolve({ stdout, stderr, code: code ?? 0 });
			});
		});
	});
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanup(client: Client) {
	console.log(`\n${DIM}Cleaning up leftover test artifacts...${RESET}`);
	const cmds = [
		// Stop any test containers
		"docker ps -q --filter label=superset.test | xargs -r docker rm -f 2>/dev/null",
		"docker ps -q --filter name=superset-verify-test | xargs -r docker rm -f 2>/dev/null",
		// Remove FIFO
		"rm -f /tmp/superset-test-fifo",
		// Remove temp dirs (best effort, only those with our marker)
		"rm -rf /tmp/superset-verify-* 2>/dev/null",
	];
	for (const cmd of cmds) {
		try {
			await sshExec(client, cmd);
		} catch {
			// ignore cleanup errors
		}
	}
	console.log(`${DIM}Cleanup complete.${RESET}`);
}

// ---------------------------------------------------------------------------
// Test definitions
// ---------------------------------------------------------------------------

type TestResult = { status: "pass" | "fail" | "skip"; detail: string };

async function test1_fifoEnvFile(client: Client): Promise<TestResult> {
	const script = `
set -e
CID=$(docker run -d --rm --name superset-verify-test-fifo alpine sleep 300)
trap "docker stop $CID 2>/dev/null; rm -f /tmp/superset-test-fifo" EXIT

mkfifo /tmp/superset-test-fifo && chmod 600 /tmp/superset-test-fifo

printf 'SUPERSET_TEST_SECRET=verified_fifo_works\\n' > /tmp/superset-test-fifo &
WRITER_PID=$!

RESULT=$(docker exec --env-file /tmp/superset-test-fifo $CID env 2>&1 | grep SUPERSET_TEST_SECRET || true)
wait $WRITER_PID 2>/dev/null || true

echo "FIFO_RESULT=$RESULT"
`.trim();

	try {
		const { stdout, stderr, code } = await sshExec(client, script, {
			timeout: 30_000,
		});
		const output = stdout + stderr;
		if (output.includes("SUPERSET_TEST_SECRET=verified_fifo_works")) {
			return { status: "pass", detail: "FIFO + --env-file works" };
		}
		return {
			status: "fail",
			detail: `Expected SUPERSET_TEST_SECRET=verified_fifo_works in output.\nstdout: ${stdout.trim()}\nstderr: ${stderr.trim()}\nexit code: ${code}`,
		};
	} catch (err: any) {
		return { status: "fail", detail: err.message };
	}
}

async function test2_ptyExec(client: Client): Promise<TestResult> {
	// First create a container
	const setup = await sshExec(
		client,
		"docker run -d --rm --name superset-verify-test-pty alpine sleep 300",
		{ timeout: 30_000 },
	);
	const cid = setup.stdout.trim();
	if (!cid) {
		return {
			status: "fail",
			detail: `Failed to create container: ${setup.stderr}`,
		};
	}

	try {
		// Run with PTY enabled on the ssh2 exec
		const cmd = `docker exec -it ${cid} /bin/sh -c 'echo "PTY_TEST_OK"; tty'`;
		const { stdout, stderr } = await sshExec(client, cmd, {
			pty: true,
			timeout: 15_000,
		});
		const output = stdout + stderr;

		const hasPtyOk = output.includes("PTY_TEST_OK");
		const hasNotATty = output.includes("not a tty");
		const hasPts = /\/dev\/pts\/\d+/.test(output);

		if (hasPtyOk && !hasNotATty && hasPts) {
			const ptsMatch = output.match(/\/dev\/pts\/\d+/)?.[0];
			return { status: "pass", detail: `PTY allocated: ${ptsMatch}` };
		}
		if (hasPtyOk && !hasNotATty) {
			return {
				status: "pass",
				detail: "PTY_TEST_OK received, tty present (non-pts)",
			};
		}
		return {
			status: "fail",
			detail: `hasPtyOk=${hasPtyOk} hasNotATty=${hasNotATty} hasPts=${hasPts}\nOutput: ${output.trim()}`,
		};
	} finally {
		await sshExec(client, `docker stop ${cid} 2>/dev/null`).catch(() => {});
	}
}

async function test3_devcontainerMount(client: Client): Promise<TestResult> {
	// Check if devcontainer CLI is available
	const whichResult = await sshExec(client, "which devcontainer 2>/dev/null");
	if (whichResult.code !== 0 || !whichResult.stdout.trim()) {
		return {
			status: "skip",
			detail: "devcontainer CLI not installed on remote",
		};
	}

	// Check --mount flag support
	const helpResult = await sshExec(client, "devcontainer up --help 2>&1");
	if (!helpResult.stdout.includes("--mount")) {
		return {
			status: "fail",
			detail: "devcontainer up does not support --mount flag",
		};
	}

	const script = `
set -e
TESTDIR=$(mktemp -d /tmp/superset-verify-XXXXXX)
trap "rm -rf $TESTDIR" EXIT

mkdir -p $TESTDIR/repo/.devcontainer $TESTDIR/worktrees
echo '{"image":"mcr.microsoft.com/devcontainers/base:ubuntu"}' > $TESTDIR/repo/.devcontainer/devcontainer.json
touch $TESTDIR/worktrees/MARKER_FILE

OUTPUT=$(devcontainer up \\
  --workspace-folder $TESTDIR/repo \\
  --mount "type=bind,source=$TESTDIR/worktrees,target=/workspaces/worktrees" \\
  --id-label superset.test=verify-mount 2>&1)

CID=$(echo "$OUTPUT" | grep -o '"containerId":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$CID" ]; then
  echo "DEVCONTAINER_FAIL: could not extract container ID"
  echo "OUTPUT: $OUTPUT"
  exit 1
fi

trap "docker rm -f $CID 2>/dev/null; rm -rf $TESTDIR" EXIT

if docker exec $CID ls /workspaces/worktrees/MARKER_FILE >/dev/null 2>&1; then
  echo "MOUNT_OK"
else
  echo "MOUNT_FAIL: marker file not found in container"
  docker exec $CID ls -la /workspaces/worktrees/ 2>&1 || true
fi
`.trim();

	try {
		const { stdout, stderr } = await sshExec(client, script, {
			timeout: 180_000,
		});
		const output = stdout + stderr;
		if (output.includes("MOUNT_OK")) {
			return {
				status: "pass",
				detail: "--mount bind mount accessible inside container",
			};
		}
		return { status: "fail", detail: output.trim().slice(0, 500) };
	} catch (err: any) {
		return { status: "fail", detail: err.message };
	}
}

async function test4_worktreeAbsolutePaths(
	client: Client,
): Promise<TestResult> {
	const script = `
set -e
TESTDIR=$(mktemp -d /tmp/superset-verify-XXXXXX)
trap "rm -rf $TESTDIR" EXIT

mkdir -p $TESTDIR/repo $TESTDIR/worktrees
cd $TESTDIR/repo
git init -q
git config user.email "test@superset.sh"
git config user.name "Superset Test"
git commit --allow-empty -m "init" -q

CID=$(docker run -d --rm --name superset-verify-test-wt -v $TESTDIR:/workspaces alpine sleep 300)
trap "docker stop $CID 2>/dev/null; rm -rf $TESTDIR" EXIT

docker exec $CID apk add --no-cache git >/dev/null 2>&1

docker exec $CID sh -c '
  cd /workspaces/repo &&
  git config user.email "test@superset.sh" &&
  git config user.name "Superset Test" &&
  git worktree add /workspaces/worktrees/test-branch -b test-branch HEAD 2>&1
'

GITFILE=$(docker exec $CID cat /workspaces/worktrees/test-branch/.git 2>&1)
echo "GITFILE_CONTENT=$GITFILE"
`.trim();

	try {
		const { stdout, stderr } = await sshExec(client, script, {
			timeout: 60_000,
		});
		const output = stdout + stderr;
		const match = output.match(/GITFILE_CONTENT=(.*)/);
		if (!match) {
			return {
				status: "fail",
				detail: `Could not read .git file.\nOutput: ${output.trim().slice(0, 500)}`,
			};
		}

		const gitfileContent = match[1].trim();
		// Should contain container-relative path
		if (
			gitfileContent.includes(
				"gitdir: /workspaces/repo/.git/worktrees/test-branch",
			)
		) {
			return {
				status: "pass",
				detail: `Worktree uses container path: ${gitfileContent}`,
			};
		}
		return {
			status: "fail",
			detail: `Expected container-relative path. Got: ${gitfileContent}`,
		};
	} catch (err: any) {
		return { status: "fail", detail: err.message };
	}
}

async function test5_sshAgentForwarding(client: Client): Promise<TestResult> {
	if (authMethod !== "agent") {
		return {
			status: "skip",
			detail: "Auth method is not 'agent'; agent forwarding not configured",
		};
	}

	try {
		const { stdout, code } = await sshExec(
			client,
			'echo "SSH_AUTH_SOCK=$SSH_AUTH_SOCK"',
		);

		const sockMatch = stdout.match(/SSH_AUTH_SOCK=(.+)/);
		const sockValue = sockMatch?.[1]?.trim();

		if (!sockValue) {
			return {
				status: "fail",
				detail: "SSH_AUTH_SOCK is empty on the remote host",
			};
		}

		// Try a test with ssh-add to confirm the agent is reachable
		const { stdout: agentOut, code: agentCode } = await sshExec(
			client,
			"ssh-add -l 2>&1",
		);

		if (agentCode === 0) {
			const keyCount = agentOut.trim().split("\n").length;
			return {
				status: "pass",
				detail: `SSH_AUTH_SOCK=${sockValue}, ${keyCount} key(s) available`,
			};
		}
		if (agentOut.includes("no identities")) {
			return {
				status: "pass",
				detail: `SSH_AUTH_SOCK=${sockValue} (agent reachable, but no keys loaded)`,
			};
		}
		return {
			status: "fail",
			detail: `SSH_AUTH_SOCK=${sockValue} but agent not reachable: ${agentOut.trim()}`,
		};
	} catch (err: any) {
		return { status: "fail", detail: err.message };
	}
}

async function test6_devcontainerJsonLog(client: Client): Promise<TestResult> {
	const whichResult = await sshExec(client, "which devcontainer 2>/dev/null");
	if (whichResult.code !== 0 || !whichResult.stdout.trim()) {
		return {
			status: "skip",
			detail: "devcontainer CLI not installed on remote",
		};
	}

	const script = `
set -e
TESTDIR=$(mktemp -d /tmp/superset-verify-XXXXXX)
trap "rm -rf $TESTDIR" EXIT

mkdir -p $TESTDIR/repo/.devcontainer
echo '{"image":"mcr.microsoft.com/devcontainers/base:ubuntu"}' > $TESTDIR/repo/.devcontainer/devcontainer.json

OUTPUT=$(devcontainer up \\
  --workspace-folder $TESTDIR/repo \\
  --log-format json \\
  --id-label superset.test=verify-json 2>&1)

CID=$(echo "$OUTPUT" | grep -o '"containerId":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$CID" ]; then
  docker rm -f $CID 2>/dev/null
fi

echo "$OUTPUT"
`.trim();

	try {
		const { stdout, stderr } = await sshExec(client, script, {
			timeout: 180_000,
		});
		const output = stdout + stderr;
		const lines = output.trim().split("\n").filter(Boolean);

		let jsonLines = 0;
		let nonJsonLines = 0;
		for (const line of lines) {
			try {
				JSON.parse(line);
				jsonLines++;
			} catch {
				nonJsonLines++;
			}
		}

		if (jsonLines > 0 && jsonLines >= nonJsonLines) {
			return {
				status: "pass",
				detail: `${jsonLines} JSON lines out of ${lines.length} total lines`,
			};
		}
		return {
			status: "fail",
			detail: `Only ${jsonLines}/${lines.length} lines were valid JSON. First line: ${lines[0]?.slice(0, 120)}`,
		};
	} catch (err: any) {
		return { status: "fail", detail: err.message };
	}
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests: { name: string; fn: (c: Client) => Promise<TestResult> }[] = [
	{ name: "FIFO + docker exec --env-file", fn: test1_fifoEnvFile },
	{ name: "PTY via ssh2 exec + docker exec -it", fn: test2_ptyExec },
	{ name: "devcontainer up --mount bind mounts", fn: test3_devcontainerMount },
	{
		name: "Worktree absolute paths inside container",
		fn: test4_worktreeAbsolutePaths,
	},
	{ name: "SSH agent forwarding availability", fn: test5_sshAgentForwarding },
	{ name: "devcontainer up --log-format json", fn: test6_devcontainerJsonLog },
];

async function main() {
	console.log(`\n${BOLD}Devcontainer Plan Verification${RESET}`);
	console.log(
		`${DIM}Host: ${host}:${port} | User: ${username} | Auth: ${authMethod}${RESET}\n`,
	);

	let client: Client;
	try {
		client = await connect();
		console.log(`${DIM}Connected to ${host}${RESET}\n`);
	} catch (err: any) {
		console.error(`${RED}Failed to connect: ${err.message}${RESET}`);
		process.exit(1);
	}

	if (cleanupOnly) {
		await cleanup(client);
		client.end();
		process.exit(0);
	}

	const results: { name: string; result: TestResult }[] = [];
	let testNum = 0;

	for (const test of tests) {
		testNum++;
		process.stdout.write(`${DIM}[${testNum}/6]${RESET} ${test.name}... `);

		const result = await test.fn(client);
		results.push({ name: test.name, result });

		switch (result.status) {
			case "pass":
				console.log(`${PASS} PASS`);
				console.log(`      ${DIM}${result.detail}${RESET}`);
				break;
			case "fail":
				console.log(`${FAIL} FAIL`);
				console.log(`      ${RED}${result.detail}${RESET}`);
				break;
			case "skip":
				console.log(`${SKIP} SKIP`);
				console.log(`      ${YELLOW}${result.detail}${RESET}`);
				break;
		}
		console.log();
	}

	// Cleanup
	await cleanup(client);
	client.end();

	// Summary
	const passed = results.filter((r) => r.result.status === "pass").length;
	const failed = results.filter((r) => r.result.status === "fail").length;
	const skipped = results.filter((r) => r.result.status === "skip").length;

	console.log(`\n${BOLD}Summary${RESET}`);
	console.log(
		`  ${GREEN}${passed} passed${RESET}  ${failed > 0 ? RED : ""}${failed} failed${RESET}  ${YELLOW}${skipped} skipped${RESET}`,
	);
	console.log();

	if (failed > 0) {
		console.log(
			`${RED}${BOLD}Some assumptions do not hold. Review failures above.${RESET}`,
		);
		process.exit(1);
	} else {
		console.log(
			`${GREEN}${BOLD}All tested assumptions verified.${RESET}${skipped > 0 ? ` (${skipped} skipped)` : ""}`,
		);
		process.exit(0);
	}
}

main().catch((err) => {
	console.error(`${RED}Unexpected error: ${err.message}${RESET}`);
	process.exit(1);
});
