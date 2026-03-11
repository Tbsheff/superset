// Auth removed — single-user local mode. Stubs for compatibility.

let authToken: string | null = null;

export function setAuthToken(token: string | null) {
	authToken = token;
}

export function getAuthToken(): string | null {
	return authToken;
}

let jwt: string | null = null;

export function setJwt(token: string | null) {
	jwt = token;
}

export function getJwt(): string | null {
	return jwt;
}

// Stub session hook — always returns a static local user
const LOCAL_SESSION = {
	user: {
		id: "00000000-0000-0000-0000-000000000001",
		name: "Local User",
		email: "local@localhost",
		emailVerified: true,
		image: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	},
	session: {
		id: "local-session",
	},
};

export const authClient = {
	useSession: () => ({
		data: LOCAL_SESSION,
		isPending: false,
		isRefetching: false,
		refetch: async () => LOCAL_SESSION,
		error: null,
	}),
	organization: {
		setActive: async (_opts: Record<string, unknown>) => {},
	},
	signOut: async () => {},
};
