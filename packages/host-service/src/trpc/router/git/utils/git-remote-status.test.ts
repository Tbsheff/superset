import { describe, expect, test } from "bun:test";
import { parsePorcelainStatus } from "./git-remote-status";

describe("parsePorcelainStatus", () => {
	test("staged modification", () => {
		const raw = "M  src/foo.ts\0";
		expect(parsePorcelainStatus(raw)).toEqual([
			{ index: "M", working_dir: " ", path: "src/foo.ts" },
		]);
	});

	test("unstaged modification (leading space preserved)", () => {
		const raw = " M src/foo.ts\0";
		expect(parsePorcelainStatus(raw)).toEqual([
			{ index: " ", working_dir: "M", path: "src/foo.ts" },
		]);
	});

	test("untracked file", () => {
		const raw = "?? new.ts\0";
		expect(parsePorcelainStatus(raw)).toEqual([
			{ index: "?", working_dir: "?", path: "new.ts" },
		]);
	});

	test("staged rename keeps new path and source `from`", () => {
		// porcelain -z renames emit `<new>\0<old>` matching simple-git's parse.
		const raw = "R  src/new.ts\0src/old.ts\0";
		expect(parsePorcelainStatus(raw)).toEqual([
			{
				index: "R",
				working_dir: " ",
				path: "src/new.ts",
				from: "src/old.ts",
			},
		]);
	});

	test("copy carries source `from`", () => {
		const raw = "C  src/copy.ts\0src/orig.ts\0";
		expect(parsePorcelainStatus(raw)).toEqual([
			{
				index: "C",
				working_dir: " ",
				path: "src/copy.ts",
				from: "src/orig.ts",
			},
		]);
	});

	test("mixed entries including a rename", () => {
		const raw = "M  a.ts\0" + " M b.ts\0" + "R  new.ts\0old.ts\0" + "?? c.ts\0";
		expect(parsePorcelainStatus(raw)).toEqual([
			{ index: "M", working_dir: " ", path: "a.ts" },
			{ index: " ", working_dir: "M", path: "b.ts" },
			{ index: "R", working_dir: " ", path: "new.ts", from: "old.ts" },
			{ index: "?", working_dir: "?", path: "c.ts" },
		]);
	});

	test("path with spaces survives (NUL-delimited, no quoting)", () => {
		const raw = "M  src/a file.ts\0";
		expect(parsePorcelainStatus(raw)).toEqual([
			{ index: "M", working_dir: " ", path: "src/a file.ts" },
		]);
	});

	test("empty input", () => {
		expect(parsePorcelainStatus("")).toEqual([]);
	});
});
