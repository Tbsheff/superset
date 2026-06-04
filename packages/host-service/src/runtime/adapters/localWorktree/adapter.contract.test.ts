import { mkdtempSync, rmSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { describeRuntimeProviderContract } from "../../contract/index.ts";
import type { ShellHandle, StartShellOptions } from "../../seam/index.ts";
import { type LocalShellFactory, LocalWorktreeAdapter } from "./index.ts";

const repos: string[] = [];

async function initRepo(): Promise<{ git: SimpleGit; path: string }> {
	const path = mkdtempSync(join(tmpdir(), "superset-local-contract-"));
	repos.push(path);
	const git = simpleGit(path);
	await git.init();
	await git.raw(["config", "user.email", "test@example.com"]);
	await git.raw(["config", "user.name", "test"]);
	await git.raw(["config", "commit.gpgsign", "false"]);
	await git.raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
	// A committed baseline so the working tree starts clean (the diff contract
	// asserts a clean repo first).
	await writeFile(join(path, ".keep"), "seed\n");
	await git.raw(["add", "--", ".keep"]);
	await git.raw(["commit", "-m", "seed"]);
	return { git, path };
}

/**
 * A grammar-interpreting shell over a REAL worktree. The contract suite mutates
 * a runtime's FS by writing the WRITE/RM/STAGE grammar to `startShell().write()`;
 * a raw bash PTY would not interpret those tokens, so this factory applies them
 * to the real temp worktree on disk (real files, real `git add`). The diff then
 * comes from the adapter's real `collectWorkspacePatch`, exercising the genuine
 * git path — not an in-memory stand-in.
 */
function makeGrammarShellFactory(git: SimpleGit): LocalShellFactory {
	return async ({
		worktreePath,
	}: {
		workspaceId: string;
		worktreePath: string;
		opts: StartShellOptions;
	}): Promise<ShellHandle> => {
		const dataCbs = new Set<(chunk: string) => void>();
		const exitCbs = new Set<
			(info: { exitCode: number; signal?: number }) => void
		>();
		const pending: Promise<void>[] = [];

		const apply = (raw: string): void => {
			const line = raw.replace(/\r?\n$/, "");
			const [verb, ...rest] = line.split(" ");
			if (verb === "WRITE") {
				const [path, b64] = rest;
				if (path === undefined || b64 === undefined) return;
				// Write the file, then mark it intent-to-add so an untracked file
				// shows up in `git diff` — the same mechanism the product uses to
				// surface untracked files (see git-helpers.ts intent-to-add path).
				pending.push(
					writeFile(
						join(worktreePath, path),
						Buffer.from(b64, "base64").toString("utf8"),
					).then(() =>
						git.raw(["add", "--intent-to-add", "--", path]).then(() => {}),
					),
				);
			} else if (verb === "RM") {
				const [path] = rest;
				if (path === undefined) return;
				pending.push(rm(join(worktreePath, path), { force: true }));
			} else if (verb === "STAGE") {
				const [path] = rest;
				if (path === undefined) return;
				pending.push(git.raw(["add", "--", path]).then(() => {}));
			}
			for (const cb of dataCbs) cb(`${line}\n`);
		};

		return {
			surface: { kind: "pty" },
			write: (data) => apply(data),
			resize: () => {},
			onData: (cb) => {
				dataCbs.add(cb);
				return {
					dispose: () => {
						dataCbs.delete(cb);
					},
				};
			},
			onExit: (cb) => {
				exitCbs.add(cb);
				return {
					dispose: () => {
						exitCbs.delete(cb);
					},
				};
			},
			kill: async () => {
				await Promise.all(pending);
				for (const cb of exitCbs) cb({ exitCode: 0 });
			},
		};
	};
}

describeRuntimeProviderContract({
	name: "local-worktree",
	makeAdapter: async () => {
		const { git, path } = await initRepo();
		return new LocalWorktreeAdapter(
			{
				db: {} as never,
				git: async () => git,
				shellFactory: makeGrammarShellFactory(git),
			},
			() => path,
		);
	},
});

// `afterAll` is registered by importing it here so the temp repos are cleaned up
// after the whole contract suite finishes.
import { afterAll } from "bun:test";

afterAll(() => {
	for (const path of repos) rmSync(path, { recursive: true, force: true });
});
