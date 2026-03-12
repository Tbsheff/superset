import { createTRPCProxyClient } from "@trpc/client";
import type { AppRouter } from "lib/trpc/routers";
import superjson from "superjson";
import { ipcLink } from "trpc-electron/renderer";

export const vanillaElectronTrpc = createTRPCProxyClient<AppRouter>({
	links: [ipcLink({ transformer: superjson })],
});
