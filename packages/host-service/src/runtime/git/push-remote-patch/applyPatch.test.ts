import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { SimpleGit } from "simple-git";
import { applyPatch, classifyPatch } from "./applyPatch.ts";

const MAILBOX = Buffer.from(
	`From 1234567890abcdef1234567890abcdef12345678 Mon Sep 17 00:00:00 2001
From: Tester <t@example.com>
Subject: [PATCH] add a file

---
 a.txt | 1 +
`,
);

const UNIFIED = Buffer.from(
	`diff --git a/a.txt b/a.txt
new file mode 100644
index 0000000..e69de29
`,
);

interface RawCall {
	args: string[];
}

function makeGit(onRaw?: (args: string[]) => void): {
	git: SimpleGit;
	calls: RawCall[];
} {
	const calls: RawCall[] = [];
	const git = {
		raw: async (args: string[]) => {
			calls.push({ args });
			onRaw?.(args);
			return "";
		},
	} as unknown as SimpleGit;
	return { git, calls };
}

describe("classifyPatch", () => {
	test("recognizes a format-patch mailbox by its From <sha> header", () => {
		expect(classifyPatch(MAILBOX)).toBe("mailbox");
	});

	test("treats a bare unified diff as unified-diff", () => {
		expect(classifyPatch(UNIFIED)).toBe("unified-diff");
	});

	test("treats empty input as unified-diff", () => {
		expect(classifyPatch(Buffer.alloc(0))).toBe("unified-diff");
	});
});

describe("applyPatch", () => {
	test("applies a mailbox patch with git am --3way", async () => {
		const { git, calls } = makeGit();
		const kind = await applyPatch(git, MAILBOX);
		expect(kind).toBe("mailbox");
		const am = calls.find((c) => c.args[0] === "am");
		expect(am?.args.slice(0, 2)).toEqual(["am", "--3way"]);
	});

	test("applies a unified diff with git apply --index", async () => {
		const { git, calls } = makeGit();
		const kind = await applyPatch(git, UNIFIED);
		expect(kind).toBe("unified-diff");
		const apply = calls.find((c) => c.args[0] === "apply");
		expect(apply?.args).toContain("--index");
	});

	test("writes the patch bytes verbatim to the temp file passed to git", async () => {
		let seenBytes: Buffer | undefined;
		const { git } = makeGit();
		const original = git.raw.bind(git);
		git.raw = (async (args: string[]) => {
			const file = args[args.length - 1];
			if (file?.endsWith(".patch")) {
				seenBytes = await readFile(file);
			}
			return original(args);
		}) as SimpleGit["raw"];
		await applyPatch(git, UNIFIED);
		expect(seenBytes?.equals(UNIFIED)).toBe(true);
	});

	test("aborts the am on failure so the worktree is left clean", async () => {
		const calls: RawCall[] = [];
		const git = {
			raw: async (args: string[]) => {
				calls.push({ args });
				if (args[0] === "am" && args[1] === "--3way") {
					throw new Error("patch does not apply");
				}
				return "";
			},
		} as unknown as SimpleGit;
		await expect(applyPatch(git, MAILBOX)).rejects.toThrow("does not apply");
		expect(
			calls.some((c) => c.args[0] === "am" && c.args[1] === "--abort"),
		).toBe(true);
	});
});
