// Auth removed — single-user local mode. Stub client.
export const authClient = {
	getCookie: () => "",
	useSession: () => ({
		data: {
			user: {
				id: "00000000-0000-0000-0000-000000000001",
				name: "Local User",
				email: "local@localhost",
				image: null,
			},
			session: { id: "local-session" },
		},
		isPending: false,
		error: null,
	}),
} as any;

export const signIn = {} as any;
export const signOut = {} as any;
export const signUp = {} as any;
export const useSession = authClient.useSession;
