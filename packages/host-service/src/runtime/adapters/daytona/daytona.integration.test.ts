import { describe, expect, test } from "bun:test";
import { Daytona } from "@daytonaio/sdk";
import type { GitFactory } from "../../git/types.ts";
import { DaytonaRuntimeAdapter } from "./adapter.ts";
import type {
	DaytonaInstanceStore,
	RuntimeInstanceRecord,
	TokenMinter,
} from "./types.ts";

/**
 * Real-API smoke test. SKIPPED unless BOTH DAYTONA_API_KEY and
 * RUN_DAYTONA_INTEGRATION=1 are set, so normal `bun test` and CI never hit the
 * network and never fail for a missing key (skipped != failed). Exercises the
 * live create -> clone -> exec(getDiff) -> preview -> destroy slice against a
 * PUBLIC repo (no token-scope dependency) and ALWAYS destroys in `finally` so a
 * leaked sandbox cannot accrue cost.
 */
const RUN =
	(!!process.env.DAYTONA_API_KEY || !!process.env.DAYTONA_JWT_TOKEN) &&
	process.env.RUN_DAYTONA_INTEGRATION === "1";

const PUBLIC_REPO = {
	cloneUrl: "https://github.com/daytonaio/sdk.git",
	ref: "main",
};

class InMemoryStore implements DaytonaInstanceStore {
	private readonly records = new Map<string, RuntimeInstanceRecord>();
	insert(record: RuntimeInstanceRecord): void {
		if (record.externalId) this.records.set(record.externalId, record);
	}
	setPreviewUrl(externalId: string, previewUrl: string): void {
		const r = this.records.get(externalId);
		if (r) r.previewUrl = previewUrl;
	}
	markDestroyed(externalId: string, destroyedAt: number): void {
		const r = this.records.get(externalId);
		if (r) r.destroyedAt = destroyedAt;
	}
	get(externalId: string): RuntimeInstanceRecord | undefined {
		return this.records.get(externalId);
	}
}

describe.skipIf(!RUN)("daytona integration (real API)", () => {
	test("create -> clone -> exec -> preview -> destroy", async () => {
		// JWT + organizationId mirrors how the Daytona CLI authenticates; falls
		// back to a plain API key. The SDK requires organizationId with a JWT.
		const sdk = new Daytona(
			process.env.DAYTONA_JWT_TOKEN
				? {
						jwtToken: process.env.DAYTONA_JWT_TOKEN,
						organizationId: process.env.DAYTONA_ORGANIZATION_ID,
						apiUrl: process.env.DAYTONA_API_URL,
						target: process.env.DAYTONA_TARGET,
					}
				: {
						apiKey: process.env.DAYTONA_API_KEY,
						apiUrl: process.env.DAYTONA_API_URL,
						target: process.env.DAYTONA_TARGET,
					},
		);
		// A public repo needs no real scope; the in-sandbox clone succeeds without
		// a token, so the integration test does not depend on the token-mint route.
		const mintRepoScopedToken: TokenMinter = async () => ({
			token: "",
			expiresAt: Date.now() + 3_600_000,
		});
		const git: GitFactory = (async () => {
			throw new Error("integration: host git factory not used in this slice");
		}) as unknown as GitFactory;

		const adapter = new DaytonaRuntimeAdapter({
			sdk,
			store: new InMemoryStore(),
			git,
			mintRepoScopedToken,
		});

		const runtime = await adapter.createInstance({
			role: "workspace",
			workspaceId: "integration",
			repo: PUBLIC_REPO,
			env: {},
		});
		try {
			const diff = await runtime.getDiff();
			expect(typeof diff.statusPorcelain).toBe("string");
			const { url } = await runtime.exposePreview(3000);
			expect(url).toContain("3000-");
		} finally {
			await adapter.destroy(runtime.externalId, { kind: "delete" });
		}
	}, 180_000);
});
