import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type SessionResult = { user: { id: string } } | null;
type RepoRow = {
	id: string;
	owner: string;
	name: string;
	organizationId: string;
	installationId: string;
} | null;
type MemberRow = { id: string } | null;
type InstallationRow = { installationId: string; suspended: boolean } | null;
type AccountRow = { accountId: string } | null;
type PermissionResult = { permission: string; role_name: string };

let sessionResult: SessionResult = { user: { id: "user-1" } };
let repoRow: RepoRow = {
	id: "repo-row-1",
	owner: "acme",
	name: "widget",
	organizationId: "org-1",
	installationId: "inst-row-1",
};
let memberRow: MemberRow = { id: "member-1" };
let installationRow: InstallationRow = {
	installationId: "424242",
	suspended: false,
};
let accountRow: AccountRow = { accountId: "9001" };
let permissionResult: PermissionResult = {
	permission: "write",
	role_name: "write",
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

const getById = mock(async (_args: { account_id: number }) => ({
	data: { login: "octo-dev" },
}));

const getCollaboratorPermissionLevel = mock(
	async (_args: { owner: string; repo: string; username: string }) => ({
		data: permissionResult,
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
			accounts: { findFirst: async () => accountRow },
		},
	},
}));

mock.module("@superset/db/schema", () => ({
	githubRepositories: { fullName: "fullName" },
	githubInstallations: { id: "id" },
	members: { organizationId: "organizationId", userId: "userId" },
	accounts: { userId: "userId", providerId: "providerId" },
}));

mock.module("../octokit", () => ({
	githubApp: {
		octokit: {
			rest: {
				apps: { createInstallationAccessToken },
				users: { getById },
				repos: { getCollaboratorPermissionLevel },
			},
		},
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
		owner: "acme",
		name: "widget",
		organizationId: "org-1",
		installationId: "inst-row-1",
	};
	memberRow = { id: "member-1" };
	installationRow = { installationId: "424242", suspended: false };
	accountRow = { accountId: "9001" };
	permissionResult = { permission: "write", role_name: "write" };
	getSession.mockClear();
	createInstallationAccessToken.mockClear();
	getById.mockClear();
	getCollaboratorPermissionLevel.mockClear();
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

	test("returns 403 when an org member lacks repo write access", async () => {
		permissionResult = { permission: "read", role_name: "read" };
		const response = await POST(makeRequest({ owner: "acme", repo: "widget" }));
		expect(response.status).toBe(403);

		// The per-repo check ran against the resolved GitHub login.
		expect(getById).toHaveBeenCalledTimes(1);
		expect(getById.mock.calls[0]?.[0]?.account_id).toBe(9001);
		expect(getCollaboratorPermissionLevel).toHaveBeenCalledTimes(1);
		const permArgs = getCollaboratorPermissionLevel.mock.calls[0]?.[0];
		expect(permArgs?.owner).toBe("acme");
		expect(permArgs?.repo).toBe("widget");
		expect(permArgs?.username).toBe("octo-dev");

		// Lacking write access must never reach the mint.
		expect(createInstallationAccessToken).not.toHaveBeenCalled();

		const json = (await response.json()) as { error: string };
		expect(json.error).toBe("Repository not accessible");
	});

	test("returns 403 when the caller is not a collaborator at all (404 from GitHub)", async () => {
		getCollaboratorPermissionLevel.mockImplementationOnce(async () => {
			throw new Error("Not Found");
		});
		const response = await POST(makeRequest({ owner: "acme", repo: "widget" }));
		expect(response.status).toBe(403);
		expect(createInstallationAccessToken).not.toHaveBeenCalled();
	});

	test("mints a token when an org member has repo write access", async () => {
		const response = await POST(makeRequest({ owner: "acme", repo: "widget" }));
		expect(response.status).toBe(200);

		// Per-repo push access was actually verified before minting.
		expect(getCollaboratorPermissionLevel).toHaveBeenCalledTimes(1);

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

	test("mints for the maintain role (covers role_name not in legacy permission)", async () => {
		permissionResult = { permission: "write", role_name: "maintain" };
		const response = await POST(makeRequest({ owner: "acme", repo: "widget" }));
		expect(response.status).toBe(200);
		expect(createInstallationAccessToken).toHaveBeenCalledTimes(1);
	});

	test("falls back to org membership when the caller has no linked GitHub account", async () => {
		accountRow = null;
		const response = await POST(makeRequest({ owner: "acme", repo: "widget" }));
		expect(response.status).toBe(200);

		// No GitHub login to resolve -> per-repo check is skipped, org boundary holds.
		expect(getById).not.toHaveBeenCalled();
		expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled();
		expect(createInstallationAccessToken).toHaveBeenCalledTimes(1);
	});

	test("falls back to org membership when the GitHub login can't be resolved", async () => {
		getById.mockImplementationOnce(async () => {
			throw new Error("404 user gone");
		});
		const response = await POST(makeRequest({ owner: "acme", repo: "widget" }));
		expect(response.status).toBe(200);
		expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled();
		expect(createInstallationAccessToken).toHaveBeenCalledTimes(1);
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
