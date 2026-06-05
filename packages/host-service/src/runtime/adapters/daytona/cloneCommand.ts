/**
 * Env var the authenticated clone reads its token from. The token is passed to
 * `executeCommand` via its `env` argument, so it lives only in the process
 * environment — never in argv, the command string, or a command log.
 */
export const CLONE_TOKEN_ENV = "SUPERSET_CLONE_TOKEN";

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface ShallowCloneSpec {
	/** Repository URL, credential-free (the token rides the env, not the URL). */
	url: string;
	/** Sandbox-relative directory to clone into. */
	workdir: string;
	/**
	 * Base branch/tag to clone; omitted clones the remote's default branch. Must
	 * be a ref NAME, not a commit SHA — `--branch` rejects a SHA. The create flow's
	 * `baseBranch` is always a branch, matching this contract.
	 */
	baseRef?: string;
	/** Whether to attach the credential helper (false = anonymous public clone). */
	authenticated: boolean;
}

/**
 * Builds a shallow `git clone` (one commit, single branch, no tags) so a large
 * monorepo neither overflows the sandbox disk nor pays the full-history transfer.
 *
 * SECURITY: when authenticated, credentials come from an inline credential helper
 * that reads the token from `$CLONE_TOKEN_ENV` at clone time. The helper string is
 * single-quoted so the OUTER shell leaves `$CLONE_TOKEN_ENV` literal; git's own
 * `sh -c` expands it from the inherited environment. The builder never receives
 * the token, so it is structurally impossible for the returned command to contain
 * the secret — the only requirement is that the caller pass the token via the
 * `env` argument of `executeCommand`, never inline.
 */
export function buildShallowCloneCommand(spec: ShallowCloneSpec): string {
	const flags = ["--depth=1", "--single-branch", "--no-tags"];
	if (spec.baseRef) flags.push(`--branch ${shellSingleQuote(spec.baseRef)}`);
	const tail = `clone ${flags.join(" ")} ${shellSingleQuote(spec.url)} ${shellSingleQuote(
		spec.workdir,
	)}`;
	if (!spec.authenticated) return `git ${tail}`;
	// `-c credential.helper=` first clears any inherited helper (defense in depth),
	// then installs ours. `!f(){...};f` runs via git's shell, which expands the env.
	const helper = `'!f(){ echo username=x-access-token; echo "password=$${CLONE_TOKEN_ENV}"; };f'`;
	return `git -c credential.helper= -c credential.helper=${helper} ${tail}`;
}
