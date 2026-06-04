import type { InMemoryFs } from "./inMemoryFs.ts";

/**
 * Interprets the contract suite's fake-only shell grammar (WRITE / RM / STAGE,
 * see contract/types.ts) against an in-memory FS, and returns the log line the
 * fake echoes back on its data stream. Any unrecognized input is echoed
 * verbatim (a plain shell would echo it too).
 */
export function applyShellCommand(fs: InMemoryFs, raw: string): string {
	const line = raw.replace(/\r?\n$/, "");
	const [verb, ...rest] = line.split(" ");
	switch (verb) {
		case "WRITE": {
			const [path, b64] = rest;
			if (path === undefined || b64 === undefined) return `${line}\n`;
			fs.write(path, Buffer.from(b64, "base64").toString("utf8"));
			return `wrote ${path}\n`;
		}
		case "RM": {
			const [path] = rest;
			if (path === undefined) return `${line}\n`;
			fs.remove(path);
			return `removed ${path}\n`;
		}
		case "STAGE": {
			const [path] = rest;
			if (path === undefined) return `${line}\n`;
			fs.stage(path);
			return `staged ${path}\n`;
		}
		default:
			return `${line}\n`;
	}
}
