// Auth removed — single-user local mode. Env stub.
export const env = {
	GH_CLIENT_ID: undefined as string | undefined,
	GH_CLIENT_SECRET: undefined as string | undefined,
	BETTER_AUTH_SECRET: "local-dev-secret",
	KV_REST_API_URL: undefined as string | undefined,
	KV_REST_API_TOKEN: undefined as string | undefined,
	NEXT_PUBLIC_COOKIE_DOMAIN: "localhost",
	NEXT_PUBLIC_API_URL:
		process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5391",
	NEXT_PUBLIC_WEB_URL:
		process.env.NEXT_PUBLIC_WEB_URL ?? "http://localhost:5490",
	NEXT_PUBLIC_ADMIN_URL:
		process.env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:5693",
	NEXT_PUBLIC_MARKETING_URL:
		process.env.NEXT_PUBLIC_MARKETING_URL ?? "http://localhost:5592",
	NEXT_PUBLIC_DESKTOP_URL: undefined as string | undefined,
};
