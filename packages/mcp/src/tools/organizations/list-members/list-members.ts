import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function register(server: McpServer) {
	server.registerTool(
		"list_members",
		{
			description: "List members in the organization",
			inputSchema: {
				search: z.string().optional().describe("Search by name or email"),
				limit: z.number().int().min(1).max(100).default(50),
			},
			outputSchema: {
				members: z.array(
					z.object({
						id: z.string(),
						name: z.string().nullable(),
						email: z.string(),
						image: z.string().nullable(),
						role: z.string(),
					}),
				),
			},
		},
		async (_args, _extra) => {
			const membersList: never[] = [];

			return {
				structuredContent: { members: membersList },
				content: [
					{
						type: "text",
						text: JSON.stringify({ members: membersList }, null, 2),
					},
				],
			};
		},
	);
}
