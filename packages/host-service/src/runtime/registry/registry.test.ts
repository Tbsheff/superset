import { describe, expect, test } from "bun:test";
import {
	FakeDaytonaSdk,
	FakeInstanceStore,
} from "../adapters/daytona/test-support/fake-sandbox.ts";
import type { TokenMinter } from "../adapters/daytona/types.ts";
import type { GitFactory } from "../git/types.ts";
import { isRuntimeProviderError } from "../seam/index.ts";
import { getRuntimeAdapter, type RuntimeAdapterDeps } from "./registry.ts";

const localDeps: RuntimeAdapterDeps = {
	db: {
		query: { workspaces: { findFirst: () => ({ sync: () => undefined }) } },
	} as never,
	git: (async () => ({}) as never) as GitFactory,
};

const mintRepoScopedToken: TokenMinter = async ({ owner, repo }) => ({
	token: `ghs_${owner}_${repo}`,
	expiresAt: Date.now() + 3_600_000,
});

function remoteDeps(
	overrides?: Partial<RuntimeAdapterDeps>,
): RuntimeAdapterDeps {
	return {
		...localDeps,
		sdk: new FakeDaytonaSdk() as never,
		store: new FakeInstanceStore(),
		mintRepoScopedToken,
		...overrides,
	};
}

describe("getRuntimeAdapter", () => {
	test("'local' resolves to the local-worktree adapter", () => {
		const adapter = getRuntimeAdapter("local", localDeps);
		expect(adapter.descriptor.provider).toBe("local-worktree");
	});

	test("'remote' builds the Daytona adapter when fully configured", () => {
		const adapter = getRuntimeAdapter("remote", remoteDeps());
		expect(adapter.descriptor.provider).toBe("daytona");
	});

	test("'remote' throws CONFIG_MISSING when the sdk is absent", () => {
		try {
			getRuntimeAdapter("remote", remoteDeps({ sdk: undefined }));
			throw new Error("expected getRuntimeAdapter to throw");
		} catch (error) {
			expect(isRuntimeProviderError(error)).toBe(true);
			if (isRuntimeProviderError(error)) {
				expect(error.code).toBe("CONFIG_MISSING");
			}
		}
	});

	test("'remote' throws CONFIG_MISSING when the store is absent", () => {
		expect(() =>
			getRuntimeAdapter("remote", remoteDeps({ store: undefined })),
		).toThrow(/Daytona is not configured/);
	});

	test("'remote' throws CONFIG_MISSING when the token minter is absent", () => {
		try {
			getRuntimeAdapter(
				"remote",
				remoteDeps({ mintRepoScopedToken: undefined }),
			);
			throw new Error("expected getRuntimeAdapter to throw");
		} catch (error) {
			expect(isRuntimeProviderError(error)).toBe(true);
			if (isRuntimeProviderError(error)) {
				expect(error.code).toBe("CONFIG_MISSING");
			}
		}
	});

	test("unknown kind throws", () => {
		expect(() => getRuntimeAdapter("bogus" as never, localDeps)).toThrow(
			/No runtime adapter for kind/,
		);
	});
});
