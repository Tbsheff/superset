/**
 * Write a file into a Daytona sandbox via `process.executeCommand` + base64,
 * bypassing the SDK's `fs.uploadFile` — that path requires the `form-data`
 * module, which is not resolvable in the bundled host-service "node" runtime
 * ("Cannot find module 'form-data'"). The path resolves relative to the sandbox
 * user `$HOME`, matching `fs.uploadFile`'s own convention, so callers pass the
 * same home-relative path they would to the SDK.
 *
 * The bytes ride the command line as base64, so this suits small files (creds,
 * config, typical source files) — not multi-megabyte uploads.
 */
export async function writeSandboxFileViaExec(
	executeCommand: (
		command: string,
	) => Promise<{ result?: string; exitCode?: number }>,
	content: Buffer | Uint8Array | string,
	homeRelativePath: string,
	options?: { mode?: string },
): Promise<void> {
	const buf =
		typeof content === "string"
			? Buffer.from(content, "utf8")
			: Buffer.from(content);
	const base64 = buf.toString("base64");
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const slash = homeRelativePath.lastIndexOf("/");
	const dir = slash > 0 ? homeRelativePath.slice(0, slash) : "";
	const quotedPath = quote(homeRelativePath);
	const mkdir = dir ? `mkdir -p ${quote(dir)} && ` : "";
	const chmod = options?.mode ? ` && chmod ${options.mode} ${quotedPath}` : "";
	const script = `cd "$HOME" && ${mkdir}printf '%s' ${quote(base64)} | base64 -d > ${quotedPath}${chmod}`;
	const res = await executeCommand(script);
	if ((res.exitCode ?? 0) !== 0) {
		throw new Error(
			`writeSandboxFileViaExec(${homeRelativePath}) failed (exit ${res.exitCode}): ${res.result ?? ""}`,
		);
	}
}
