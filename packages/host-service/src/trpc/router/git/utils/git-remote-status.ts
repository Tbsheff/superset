import type { ChangedFile } from "../types";
import {
	buildBranch,
	getChangedFilesForDiff,
	mapGitStatus,
	parseNameStatus,
	parseNumstat,
} from "./git-helpers";
import type { GitRunner } from "./git-runner";
import type { GitStatusSnapshot } from "./git-status";

/** One entry of `git status --porcelain=v1`, shaped like simple-git's `files`. */
export interface PorcelainEntry {
	index: string;
	working_dir: string;
	path: string;
	from?: string;
}

/**
 * Parse `git status --porcelain=v1 -z` into the subset of simple-git's
 * `StatusResult.files` the snapshot consumes (`index`, `working_dir`, `path`,
 * `from`). NUL-delimited so paths with spaces/newlines survive; rename/copy
 * entries (`R`/`C` in either column) carry the source path as a trailing
 * NUL-separated cell, matching git's `-z` rename encoding (`<new>\0<old>`).
 */
export function parsePorcelainStatus(raw: string): PorcelainEntry[] {
	const entries: PorcelainEntry[] = [];
	const cells = raw.split("\0");
	for (let i = 0; i < cells.length; i++) {
		const cell = cells[i];
		// A porcelain v1 record is `XY <path>`: two status chars, a space, path.
		if (!cell || cell.length < 4) continue;
		const index = cell[0] ?? " ";
		const working_dir = cell[1] ?? " ";
		const path = cell.slice(3);
		if (
			index === "R" ||
			index === "C" ||
			working_dir === "R" ||
			working_dir === "C"
		) {
			const from = cells[++i] ?? "";
			entries.push({ index, working_dir, path, from });
		} else {
			entries.push({ index, working_dir, path });
		}
	}
	return entries;
}

/** Runner version of `getDefaultBranchName` (refs.ts is SimpleGit-typed). */
async function getDefaultBranchNameViaRunner(
	runner: GitRunner,
): Promise<string | null> {
	try {
		const ref = await runner.raw([
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
			"--short",
		]);
		return ref.trim().replace(/^origin\//, "");
	} catch {
		return null;
	}
}

/** Runner version of `resolveUpstream` (refs.ts is SimpleGit-typed). */
async function resolveUpstreamViaRunner(
	runner: GitRunner,
	branch: string,
): Promise<{ remote: string; remoteBranch: string } | null> {
	try {
		const [remote, merge] = await Promise.all([
			runner.raw(["config", "--get", `branch.${branch}.remote`]),
			runner.raw(["config", "--get", `branch.${branch}.merge`]),
		]);
		const remoteBranch = merge.trim().replace(/^refs\/heads\//, "");
		const remoteName = remote.trim();
		if (!remoteName || !remoteBranch) return null;
		return { remote: remoteName, remoteBranch };
	} catch {
		return null;
	}
}

/** Runner version of `resolveBaseComparison` (refs.ts is SimpleGit-typed). */
export async function resolveBaseComparisonViaRunner(
	runner: GitRunner,
	explicitBranch?: string,
): Promise<{ branchName: string; baseRef: string } | null> {
	const branchName =
		explicitBranch ?? (await getDefaultBranchNameViaRunner(runner));
	if (!branchName) return null;
	const upstream = await resolveUpstreamViaRunner(runner, branchName);
	const baseRef = upstream
		? upstream.remote === "."
			? upstream.remoteBranch
			: `${upstream.remote}/${upstream.remoteBranch}`
		: `origin/${branchName}`;
	return { branchName, baseRef };
}

export { getDefaultBranchNameViaRunner };

/** Single-quote a shell argument for an in-sandbox command. */
function shellQuote(arg: string): string {
	return `'${arg.replaceAll("'", "'\\''")}'`;
}

/**
 * Count lines of untracked files in-sandbox, mirroring `countUntrackedFileLines`
 * but without host filesystem access. One `wc -l` per file via the runner's
 * shell escape; the local arm's binary-sniff and size cap are skipped — a
 * non-zero count on a binary file is a cosmetic LOC overstate, never a
 * correctness issue. Needs `execShell` (remote-only); a no-op otherwise.
 */
async function countUntrackedFileLinesRemote(
	runner: GitRunner,
	files: ChangedFile[],
): Promise<void> {
	const execShell = runner.execShell;
	if (!execShell || files.length === 0) return;
	await Promise.all(
		files.map(async (file) => {
			try {
				const res = await execShell(`wc -l < ${shellQuote(file.path)}`);
				if (res.exitCode !== 0) return;
				const count = Number.parseInt(res.stdout.trim(), 10);
				if (Number.isFinite(count)) file.additions = count;
			} catch {}
		}),
	);
}

/**
 * Remote rename detection, mirroring `detectUnstagedRenames` but run entirely
 * in-sandbox: copy the index aside, intent-to-add untracked paths against the
 * copy, then `git diff -M`. `GIT_INDEX_FILE` scopes the writes to the temp copy
 * so the real index is never mutated. Needs `execShell` (remote-only). Falls
 * back to an empty result on any error — the caller still has the unrelated
 * deleted+untracked entries to display.
 */
async function detectUnstagedRenamesRemote(
	runner: GitRunner,
	untrackedPaths: string[],
	hasDeletions: boolean,
): Promise<
	Array<{
		oldPath: string;
		newPath: string;
		status: "renamed";
		additions: number;
		deletions: number;
	}>
> {
	const execShell = runner.execShell;
	if (!execShell || untrackedPaths.length === 0 || !hasDeletions) return [];

	try {
		const gitDir = (await runner.raw(["rev-parse", "--git-dir"])).trim();
		if (!gitDir) return [];
		const indexPath = `${gitDir}/index`;
		const tempPath = `${gitDir}/.superset-renames-index`;
		const env = `GIT_INDEX_FILE=${shellQuote(tempPath)}`;
		const quotedPaths = untrackedPaths.map(shellQuote).join(" ");

		const nameStatusRes = await execShell(
			`cp ${shellQuote(indexPath)} ${shellQuote(tempPath)} && ` +
				`${env} git add --intent-to-add -- ${quotedPaths} && ` +
				`${env} git diff --name-status -z -M`,
		);
		const numstatRes = await execShell(
			`${env} git diff --numstat -z -M; rm -f ${shellQuote(tempPath)}`,
		);
		if (nameStatusRes.exitCode !== 0) return [];

		const nameStatus = parseNameStatus(nameStatusRes.stdout);
		const numstat = parseNumstat(numstatRes.stdout);
		const result: Array<{
			oldPath: string;
			newPath: string;
			status: "renamed";
			additions: number;
			deletions: number;
		}> = [];
		for (const entry of nameStatus) {
			if (!entry.oldPath) continue;
			if (entry.status[0] !== "R") continue;
			const stats = numstat.get(entry.path) ?? { additions: 0, deletions: 0 };
			result.push({
				oldPath: entry.oldPath,
				newPath: entry.path,
				status: "renamed",
				additions: stats.additions,
				deletions: stats.deletions,
			});
		}
		return result;
	} catch {
		return [];
	}
}

/**
 * Remote counterpart of `getGitStatusSnapshot`. Runs the SAME git commands as
 * the local snapshot (`status --porcelain`, `diff --numstat`, `ls-files
 * --ignored`, the merge-base file list) but in-sandbox via the runner, and maps
 * to the identical `GitStatusSnapshot` shape so the Changes panel renders the
 * same for remote and local. Untracked line counts and unstaged-rename
 * detection run in-sandbox instead of via host node:fs.
 */
export async function getGitStatusSnapshotRemote({
	runner,
	baseBranch,
}: {
	runner: GitRunner;
	baseBranch?: string;
}): Promise<GitStatusSnapshot> {
	const currentBranchName = (
		await runner.raw(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")
	).trim();
	const base = await resolveBaseComparisonViaRunner(runner, baseBranch);
	const defaultBranchName = base?.branchName ?? null;
	const baseRef = base?.baseRef ?? "HEAD";

	const [currentBranch, defaultBranch, statusRaw, ignoredRaw] =
		await Promise.all([
			buildBranch(runner, currentBranchName, true, baseRef),
			defaultBranchName
				? buildBranch(runner, defaultBranchName, false)
				: buildBranch(runner, currentBranchName, true),
			runner.raw(["status", "--porcelain=v1", "-z"]).catch(() => ""),
			runner
				.raw([
					"ls-files",
					"--others",
					"--ignored",
					"--exclude-standard",
					"--directory",
				])
				.catch(() => ""),
		]);

	const statusFiles = parsePorcelainStatus(statusRaw);

	const ignoredPaths = ignoredRaw
		.split("\n")
		.map((line) => line.trim().replace(/\/$/, ""))
		.filter(Boolean);

	const againstBase = await getChangedFilesForDiff(runner, [
		`${baseRef}...HEAD`,
	]);

	const stagedNumstat = parseNumstat(
		await runner
			.raw(["diff", "--numstat", "-z", "-M", "--cached"])
			.catch(() => ""),
	);
	const staged: ChangedFile[] = [];
	for (const file of statusFiles) {
		const idx = file.index;
		if (idx && idx !== " " && idx !== "?") {
			const stats = stagedNumstat.get(file.path) ?? {
				additions: 0,
				deletions: 0,
			};
			staged.push({
				path: file.path,
				oldPath: file.from && file.from !== file.path ? file.from : undefined,
				status: mapGitStatus(idx),
				additions: stats.additions,
				deletions: stats.deletions,
			});
		}
	}

	const unstagedNumstat = parseNumstat(
		await runner.raw(["diff", "--numstat", "-z"]).catch(() => ""),
	);
	const unstaged: ChangedFile[] = [];
	const untrackedFiles: ChangedFile[] = [];
	for (const file of statusFiles) {
		const wd = file.working_dir;
		if (file.index === "?" && wd === "?") {
			const entry: ChangedFile = {
				path: file.path,
				status: "untracked",
				additions: 0,
				deletions: 0,
			};
			untrackedFiles.push(entry);
			unstaged.push(entry);
		} else if (wd && wd !== " ") {
			const stats = unstagedNumstat.get(file.path) ?? {
				additions: 0,
				deletions: 0,
			};
			unstaged.push({
				path: file.path,
				status: mapGitStatus(wd),
				additions: stats.additions,
				deletions: stats.deletions,
			});
		}
	}
	await countUntrackedFileLinesRemote(runner, untrackedFiles);

	const hasDeletions = unstaged.some((file) => file.status === "deleted");
	const renames = await detectUnstagedRenamesRemote(
		runner,
		untrackedFiles.map((file) => file.path),
		hasDeletions,
	);

	let mergedUnstaged = unstaged;
	if (renames.length > 0) {
		const consumedDeleted = new Set<string>();
		const consumedUntracked = new Set<string>();
		for (const rename of renames) {
			consumedDeleted.add(rename.oldPath);
			consumedUntracked.add(rename.newPath);
		}
		mergedUnstaged = unstaged.filter((file) => {
			if (file.status === "deleted" && consumedDeleted.has(file.path))
				return false;
			if (file.status === "untracked" && consumedUntracked.has(file.path))
				return false;
			return true;
		});
		for (const rename of renames) {
			mergedUnstaged.push({
				path: rename.newPath,
				oldPath: rename.oldPath,
				status: rename.status,
				additions: rename.additions,
				deletions: rename.deletions,
			});
		}
	}

	return {
		currentBranch,
		defaultBranch,
		againstBase,
		staged,
		unstaged: mergedUnstaged,
		ignoredPaths,
	};
}
