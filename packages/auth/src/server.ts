// Auth removed — single-user local mode
export type Session = {
	user: { id: string; name: string; email: string; image: string | null };
	session: { id: string };
};
export type User = Session["user"];
export const auth = {} as any;
