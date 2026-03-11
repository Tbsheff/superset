import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@superset/mcp";
import type { McpContext } from "@superset/mcp/auth";
import { LOCAL_USER_ID } from "@superset/shared/constants";

function verifyToken(_req: Request): AuthInfo {
	return {
		token: "local",
		clientId: "local",
		scopes: ["mcp:full"],
		extra: {
			mcpContext: {
				userId: LOCAL_USER_ID,
			} satisfies McpContext,
		},
	};
}

function getResourceMetadataUrl(req: Request): string {
	const host = req.headers.get("x-forwarded-host") ?? new URL(req.url).host;
	const proto =
		req.headers.get("x-forwarded-proto") ??
		new URL(req.url).protocol.replace(":", "");
	return `${proto}://${host}/.well-known/oauth-protected-resource`;
}

function unauthorizedResponse(req: Request): Response {
	const metadataUrl = getResourceMetadataUrl(req);
	return new Response("Unauthorized", {
		status: 401,
		headers: {
			"WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"`,
		},
	});
}

async function handleRequest(req: Request): Promise<Response> {
	const authInfo = verifyToken(req);
	if (!authInfo) return unauthorizedResponse(req);

	const transport = new WebStandardStreamableHTTPServerTransport();
	const server = createMcpServer();
	await server.connect(transport);

	return transport.handleRequest(req, { authInfo });
}

export { handleRequest as GET, handleRequest as POST, handleRequest as DELETE };
