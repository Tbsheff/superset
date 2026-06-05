import { randomUUID } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Env var the generated askpass script reads the scoped token from. */
export const GIT_ASKPASS_TOKEN_ENV = "GIT_ASKPASS_TOKEN";

/**
 * Writes a transient git askpass script. The script never embeds the token in
 * its body: it reads the scoped token from the `GIT_ASKPASS_TOKEN` env var the
 * caller passes to the spawned git process, so the token never lands on disk.
 */
export async function writeTempAskpass(): Promise<string> {
	const filePath = join(tmpdir(), `git-askpass-${randomUUID()}.sh`);
	const script = `#!/bin/sh
case "$1" in
  Username*) echo "x-access-token" ;;
  *) printf '%s\\n' "$${GIT_ASKPASS_TOKEN_ENV}" ;;
esac
`;
	await writeFile(filePath, script);
	await chmod(filePath, 0o700);
	return filePath;
}
