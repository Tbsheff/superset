import { describe, expect, test } from "bun:test";
import type { GitFactory } from "../git/types.ts";
import { getRuntimeAdapter } from "./registry.ts";

const fakeDeps = {
	db: {
		query: { workspaces: { findFirst: () => ({ sync: () => undefined }) } },
	} as never,
	git: (async () => ({}) as never) as GitFactory,
};

describe("getRuntimeAdapter", () => {
	test("'local' resolves to the local-worktree adapter", () => {
		const adapter = getRuntimeAdapter("local", fakeDeps);
		expect(adapter.descriptor.provider).toBe("local-worktree");
	});

	test("unknown kind throws", () => {
		expect(() => getRuntimeAdapter("remote" as never, fakeDeps)).toThrow(
			/No runtime adapter for kind/,
		);
	});
});
