import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type SessionResult = { user: { id: string } } | null;
type RepoRow = {
	id: string;
	name: string;
	organizationId: string;
	installationId: string;
} | null;
type MemberRow = { id: string } | null;
type InstallationRow = { installationId: string; suspended: boolean } | null;

let sessionResult: SessionResult = { user: { id: "user-1" } };
let repoRow: RepoRow = {
	id: "repo-row-1",
	name: "widget",
	organizationId: "org-1",
	installationId: "inst-row-1",
};
let memberRow: MemberRow = { id: "member-1" };
let installationRow: InstallationRow = {
	installationId: "424242",
	suspended: false,
};

const getSession = mock(async () => sessionResult);

const createInstallationAccessToken = mock(
	async (_args: {
		installation_id: number;
		repositories: string[];
		permissions: Record<string, string>;
	}) => ({
		data: {
			token: "ghs_supersecrettoken",
			expires_at: "2026-06-03T01:00:00.000Z",
		},
	}),
);

mock.module("@superset/auth/server", () => ({
	auth: { api: { getSession } },
}));

mock.module("@superset/db/client", () => ({
	db: {
		query: {
			githubRepositories: { findFirst: async () => repoRow },
			members: { findFirst: async () => memberRow },
			githubInstallations: { findFirst: async () => installationRow },
		},
	},
}));

mock.module("@superset/db/schema", () => ({
	githubRepositories: { fullName: "fullName" },
	githubInstallations: { id: "id" },
	members: { organizationId: "organizationId", userId: "userId" },
}));

mock.module("../octokit", () => ({
	githubApp: {
		octokit: { rest: { apps: { createInstallationAccessToken } } },
	},
}));

const { POST } = await import("./route");

function makeRequest(body?: unknown, rawBody?: string): Request {
	return new Request("http://localhost/api/github/scoped-token", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
	});
}

const originalError = console.error;
let errorCalls: unknown[][] = [];

beforeEach(() => {
	sessionResult = { user: { id: "user-1" } };
	repoRow = {
		id: "repo-row-1",
		name: "widget",
		organizationId: "org-1",
		installationId: "inst-row-1",
	};
	memberRow = { id: "member-1" };
	installationRow = { installationId: "424242", suspended: false };
	getSession.mockClear();
	createInstallationAccessToken.mockClear();
	errorCalls = [];
	console.error = (...args: unknown[]) => {
		errorCalls.push(args);
	};
});

afterEach(() => {
	console.error = originalError;
});

describe("github scoped-token route", () => {
	test("returns 401 when there is no session", async () => {
		sessionResult = null;
		const response = await POST(makeRequest({ owner: "acme", repo: "widget" }));
		expect(response.status).toBe(401);
		expect(createInstallationAccessToken).not.toHaveBeenCalled();
	});

	test("returns 400 on malformed JSON", async () => {
		const response = await POST(makeRequest(undefined, "{not json"));
		expect(response.status).toBe(400);
		expect(createInstallationAccessToken).not.toHaveBeenCalled();
	});

	test("returns 400 when owner/repo missing", async () => {
		const response = await POST(makeRequest({ owner: "acme" }));
		expect(response.status).toBe(400);
		expect(createInstallationAccessToken).not.toHaveBeenCalled();
	});

	test("returns 403 when the repo is unknown to us", async () => {
		repoRow = null;
		const response = await POST(makeRequest({ owner: "acme", repo: "ghost" }));
		expect(response.status).toBe(403);
		expect(createInstallationAccessToken).not.toHaveBeenCalled();
	});

	test("returns 403 when the user is not an org member", async () => {
		memberRow = null;
		const response = await POST(makeRequest({ owner: "acme", repo: "widget" }));
		expect(response.status).toBe(403);
		expect(createInstallationAccessToken).not.toHaveBeenCalled();
	});

	test("returns 409 when the installation is suspended", async () => {
		installationRow = { installationId: "424242", suspended: true };
		const response = await POST(makeRequest({ owner: "acme", repo: "widget" }));
		expect(response.status).toBe(409);
		expect(createInstallationAccessToken).not.toHaveBeenCalled();
	});

	test("returns 409 when the installation row is missing", async () => {
		installationRow = null;
		const response = await POST(makeRequest({ owner: "acme", repo: "widget" }));
		expect(response.status).toBe(409);
		expect(createInstallationAccessToken).not.toHaveBeenCalled();
	});

	test("mints a token scoped to a single repo with contents:write metadata:read", async () => {
		const response = await POST(makeRequest({ owner: "acme", repo: "widget" }));
		expect(response.status).toBe(200);

		expect(createInstallationAccessToken).toHaveBeenCalledTimes(1);
		const args = createInstallationAccessToken.mock.calls[0]?.[0];
		expect(args?.installation_id).toBe(424242);
		expect(args?.repositories).toEqual(["widget"]);
		expect(args?.permissions).toEqual({
			contents: "write",
			metadata: "read",
		});

		const json = (await response.json()) as {
			token: string;
			expiresAt: number;
		};
		expect(json.token).toBe("ghs_supersecrettoken");
		expect(json.expiresAt).toBe(new Date("2026-06-03T01:00:00.000Z").getTime());
		expect(Object.keys(json).sort()).toEqual(["expiresAt", "token"]);
	});

	test("never logs the minted token", async () => {
		await POST(makeRequest({ owner: "acme", repo: "widget" }));
		const serialized = JSON.stringify(errorCalls);
		expect(serialized).not.toContain("ghs_supersecrettoken");
	});

	test("returns 502 and does not leak the token on mint failure", async () => {
		createInstallationAccessToken.mockImplementationOnce(async () => {
			throw new Error("github 500");
		});
		const response = await POST(makeRequest({ owner: "acme", repo: "widget" }));
		expect(response.status).toBe(502);
		const json = (await response.json()) as { error: string };
		expect(json.error).toBe("Failed to mint token");

		const serialized = JSON.stringify(errorCalls);
		expect(serialized).toContain("acme/widget");
		expect(serialized).not.toContain("ghs_supersecrettoken");
	});
});
