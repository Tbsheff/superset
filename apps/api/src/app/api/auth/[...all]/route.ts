// Auth removed — single-user local mode. Stub handler.
const handler = (_req: Request) =>
	Response.json({ error: "Auth not available in single-user mode" }, { status: 404 });

export { handler as GET, handler as POST };
