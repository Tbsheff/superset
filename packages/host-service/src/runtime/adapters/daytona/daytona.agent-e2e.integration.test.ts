import { describe, expect, test } from "bun:test";
import type { GitFactory } from "../../git/types.ts";
import { DaytonaRuntimeAdapter } from "./adapter.ts";
import { createDaytonaSdk } from "./createDaytonaSdk.ts";
import type {
	DaytonaInstanceStore,
	RuntimeInstanceRecord,
	TokenMinter,
} from "./types.ts";

/**
 * End-to-end agent-execution smoke test against a REAL Daytona sandbox. SKIPPED
 * unless RUN_DAYTONA_INTEGRATION=1 and Daytona creds (DAYTONA_API_KEY, or
 * DAYTONA_JWT_TOKEN + DAYTONA_ORGANIZATION_ID) are set, so normal `bun test` and
 * CI never touch the network.
 *
 * It drives the SAME primitives the product's agent-launch path uses
 * (`DaytonaWorkspaceRuntime.startShell` + write the command, then `getDiff`),
 * proving the full remote loop: provision -> clone -> run an agent workload in
 * the sandbox -> stream output back -> the agent's change is captured for review.
 * Uses a PUBLIC repo (anonymous clone, no token scope). ALWAYS destroys the
 * sandbox in `finally`.
 */
const RUN =
	(!!process.env.DAYTONA_API_KEY || !!process.env.DAYTONA_JWT_TOKEN) &&
	process.env.RUN_DAYTONA_INTEGRATION === "1";

const PUBLIC_REPO = {
	cloneUrl: "https://github.com/daytonaio/sdk.git",
	ref: "main",
};

const SENTINEL = "SUPERSET_AGENT_E2E_DONE";
const RESULT_FILE = "AGENT_RESULT.txt";

class InMemoryStore implements DaytonaInstanceStore {
	private readonly records = new Map<string, RuntimeInstanceRecord>();
	insert(record: RuntimeInstanceRecord): void {
		if (record.externalId) this.records.set(record.externalId, record);
	}
	setPreviewUrl(externalId: string, previewUrl: string): void {
		const r = this.records.get(externalId);
		if (r) r.previewUrl = previewUrl;
	}
	markDestroyed(externalId: string, destroyedAt: number): void {
		const r = this.records.get(externalId);
		if (r) r.destroyedAt = destroyedAt;
	}
	get(externalId: string): RuntimeInstanceRecord | undefined {
		return this.records.get(externalId);
	}
}

const waitFor = async (
	predicate: () => boolean,
	timeoutMs: number,
): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 250));
	}
	return predicate();
};

describe.skipIf(!RUN)("daytona agent e2e (real API)", () => {
	test("provision -> run agent workload in sandbox -> stream -> diff captures change", async () => {
		const sdk = createDaytonaSdk({
			DAYTONA_API_KEY: process.env.DAYTONA_API_KEY,
			DAYTONA_JWT_TOKEN: process.env.DAYTONA_JWT_TOKEN,
			DAYTONA_ORGANIZATION_ID: process.env.DAYTONA_ORGANIZATION_ID,
			DAYTONA_API_URL: process.env.DAYTONA_API_URL,
			DAYTONA_TARGET: process.env.DAYTONA_TARGET,
		});
		if (!sdk)
			throw new Error("createDaytonaSdk returned undefined despite creds");

		const mintRepoScopedToken: TokenMinter = async () => ({
			token: "",
			expiresAt: Date.now() + 3_600_000,
		});
		const git: GitFactory = (async () => {
			throw new Error("e2e: host git factory not used in this slice");
		}) as unknown as GitFactory;

		const adapter = new DaytonaRuntimeAdapter({
			sdk,
			store: new InMemoryStore(),
			git,
			mintRepoScopedToken,
		});

		const runtime = await adapter.createInstance<"workspace">({
			role: "workspace",
			workspaceId: "agent-e2e",
			repo: PUBLIC_REPO,
			env: {},
		});

		try {
			// Launch a shell the same way the product's remote agent path does, then
			// write an agent workload: edit a file, stage it, print git status, and a
			// completion sentinel. This is the agent-execution path end to end.
			let output = "";
			const shell = await runtime.startShell({ cols: 120, rows: 30 });
			// onData delivers already-decoded string chunks (the transport owns the
			// UTF-8 decode), so accumulate directly.
			shell.onData((chunk) => {
				output += chunk;
			});
			// Let the interactive shell finish starting before sending input.
			await new Promise((r) => setTimeout(r, 1500));
			// The marker is split by "" so the contiguous SENTINEL appears ONLY in the
			// command's executed output, never in the PTY echo of the typed input —
			// otherwise the echo would satisfy the wait before the command ran.
			shell.write(
				`printf 'edited by a remote agent\\n' > ${RESULT_FILE} && ` +
					`git add -A && git status --porcelain && echo SUPERSET_AGENT""_E2E_DONE\n`,
			);

			const finished = await waitFor(() => output.includes(SENTINEL), 120_000);
			await new Promise((r) => setTimeout(r, 1000));

			// The agent's change is captured for review via the same diff surface the
			// Changes view / PR flow consumes.
			const diff = await runtime.getDiff();
			await shell.kill();

			expect(finished).toBe(true);
			// The command ran inside the sandbox and streamed back over the runtime.
			expect(output).toContain(RESULT_FILE);
			expect(diff.statusPorcelain).toContain(RESULT_FILE);

			if (runtime.getFileContents) {
				const contents = await runtime.getFileContents({
					path: RESULT_FILE,
					category: "unstaged",
				});
				expect(contents.newFile.contents).toContain("edited by a remote agent");
			}
		} finally {
			await adapter.destroy(runtime.externalId, { kind: "delete" });
		}
	}, 180_000);
});
