import { describe, expect, mock, test } from "bun:test";
import { ORGANIZATION_HEADER } from "@superset/shared/constants";
import { createRepoScopedTokenMinter } from "./createRepoScopedTokenMinter.ts";

const API_URL = "https://api.superset.test";
const ORGANIZATION_ID = "00000000-0000-0000-0000-000000000001";
const SCOPED_TOKEN = "ghs_scoped_write_token_secret";

function captureRequest(): {
	calls: Array<{ url: string; init: RequestInit | undefined }>;
	fetchImpl: typeof fetch;
} {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init });
		return Response.json({
			token: SCOPED_TOKEN,
			expiresAt: 1_700_000_000_000,
		});
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

function makeMinter(fetchImpl: typeof fetch) {
	return createRepoScopedTokenMinter({
		apiBaseUrl: API_URL,
		organizationId: ORGANIZATION_ID,
		authProvider: {
			getHeaders: async () => ({ Authorization: "Bearer host.session.jwt" }),
		},
		fetchImpl,
	});
}

describe("createRepoScopedTokenMinter", () => {
	test("POSTs to the scoped-token route with owner/repo body and host auth", async () => {
		const { calls, fetchImpl } = captureRequest();
		const minter = makeMinter(fetchImpl);

		await minter({ owner: "superset", repo: "demo" });

		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.url).toBe(`${API_URL}/api/github/scoped-token`);
		expect(call?.init?.method).toBe("POST");

		const headers = call?.init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer host.session.jwt");
		expect(headers[ORGANIZATION_HEADER]).toBe(ORGANIZATION_ID);
		expect(headers["Content-Type"]).toBe("application/json");

		expect(JSON.parse(String(call?.init?.body))).toEqual({
			owner: "superset",
			repo: "demo",
		});
	});

	test("maps the wire response to RepoScopedToken", async () => {
		const { fetchImpl } = captureRequest();
		const minter = makeMinter(fetchImpl);

		const result = await minter({ owner: "superset", repo: "demo" });

		expect(result).toEqual({
			token: SCOPED_TOKEN,
			expiresAt: 1_700_000_000_000,
		});
	});

	test("strips trailing slashes from the base url before building the endpoint", async () => {
		const { calls, fetchImpl } = captureRequest();
		const minter = createRepoScopedTokenMinter({
			apiBaseUrl: `${API_URL}//`,
			organizationId: ORGANIZATION_ID,
			authProvider: { getHeaders: async () => ({}) },
			fetchImpl,
		});

		await minter({ owner: "superset", repo: "demo" });

		expect(calls[0]?.url).toBe(`${API_URL}/api/github/scoped-token`);
	});

	test("throws a status-only error on a non-2xx response", async () => {
		const fetchImpl = mock(
			async () => new Response("Repository not accessible", { status: 403 }),
		) as unknown as typeof fetch;
		const minter = makeMinter(fetchImpl);

		await expect(minter({ owner: "superset", repo: "demo" })).rejects.toThrow(
			/status 403/,
		);
	});

	test("rejects a malformed success body", async () => {
		const fetchImpl = mock(async () =>
			Response.json({ token: 123, expiresAt: "soon" }),
		) as unknown as typeof fetch;
		const minter = makeMinter(fetchImpl);

		await expect(minter({ owner: "superset", repo: "demo" })).rejects.toThrow(
			/malformed/,
		);
	});

	test("never leaks the token into a thrown error message", async () => {
		// A failure path that still happens to carry the token in the body must
		// not surface it in the error. Assert the secret never appears.
		const fetchImpl = mock(
			async () =>
				new Response(
					JSON.stringify({ token: SCOPED_TOKEN, expiresAt: 1 }),
					{ status: 500 },
				),
		) as unknown as typeof fetch;
		const minter = makeMinter(fetchImpl);

		let thrown: unknown;
		try {
			await minter({ owner: "superset", repo: "demo" });
		} catch (error) {
			thrown = error;
		}
		const message = thrown instanceof Error ? thrown.message : String(thrown);
		expect(message).not.toContain(SCOPED_TOKEN);
	});

	test("never logs the token on the success path", async () => {
		const { fetchImpl } = captureRequest();
		const logged: string[] = [];
		const restore = {
			log: console.log,
			error: console.error,
			warn: console.warn,
			info: console.info,
			debug: console.debug,
		};
		const capture =
			(...args: unknown[]) => {
				logged.push(args.map(String).join(" "));
			};
		console.log = capture;
		console.error = capture;
		console.warn = capture;
		console.info = capture;
		console.debug = capture;

		try {
			const minter = makeMinter(fetchImpl);
			const result = await minter({ owner: "superset", repo: "demo" });
			expect(result.token).toBe(SCOPED_TOKEN);
		} finally {
			console.log = restore.log;
			console.error = restore.error;
			console.warn = restore.warn;
			console.info = restore.info;
			console.debug = restore.debug;
		}

		expect(logged.join("\n")).not.toContain(SCOPED_TOKEN);
	});
});
