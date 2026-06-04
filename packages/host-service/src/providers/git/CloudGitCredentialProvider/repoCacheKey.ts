/**
 * Derives a stable per-repo cache key from a git remote URL so that two
 * different repos can never share a cached scoped token. The key is the repo
 * identity (`host/owner/name`), normalized across the URL forms git accepts:
 * https, scp-like ssh (`git@host:owner/repo.git`), ssh://, trailing `.git`,
 * trailing slash, and case. Userinfo in the URL is dropped so a token embedded
 * in a remote never enters the key.
 */
export function repoCacheKey(remoteUrl: string): string {
	const trimmed = remoteUrl.trim();
	const normalized = stripGitSuffix(parsePathish(trimmed)).toLowerCase();
	return normalized || trimmed.toLowerCase();
}

function parsePathish(remoteUrl: string): string {
	const scpMatch = remoteUrl.match(/^[^/@]+@([^:/]+):(.+)$/);
	if (scpMatch?.[1] && scpMatch[2]) {
		return `${scpMatch[1]}/${stripLeadingSlash(scpMatch[2])}`;
	}

	try {
		const url = new URL(remoteUrl);
		const path = stripLeadingSlash(url.pathname);
		return `${url.host}/${path}`;
	} catch {
		return remoteUrl;
	}
}

function stripLeadingSlash(value: string): string {
	return value.replace(/^\/+/, "");
}

function stripGitSuffix(value: string): string {
	return value.replace(/\/+$/, "").replace(/\.git$/, "");
}
