import { ChatMastraService } from "@superset/chat-mastra/server/trpc";
import { LOCAL_USER_ID } from "@superset/shared/constants";
import { createCaller } from "@superset/trpc";

const caller = createCaller({ userId: LOCAL_USER_ID, headers: new Headers() });

const service = new ChatMastraService({
	headers: async () => ({}),
	apiUrl: "",
	// Adapt createCaller to match tRPC HTTP client interface (.mutate() wrappers).
	// Only chat.updateTitle is used by the service.
	apiClient: {
		chat: {
			updateTitle: {
				mutate: (input: { sessionId: string; title: string }) =>
					caller.chat.updateTitle(input),
			},
		},
	} as any,
});

export const createChatMastraServiceRouter = () => service.createRouter();

export type ChatMastraServiceDesktopRouter = ReturnType<
	typeof createChatMastraServiceRouter
>;
