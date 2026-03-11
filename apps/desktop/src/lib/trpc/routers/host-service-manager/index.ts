import { env } from "main/env.main";
import { getHostServiceManager } from "main/lib/host-service-manager";
import { publicProcedure, router } from "../..";
import { loadToken } from "../auth/utils/auth-functions";

export const createHostServiceManagerRouter = () => {
	return router({
		getLocalPort: publicProcedure
			.query(async () => {
				const manager = getHostServiceManager();
				const { token } = await loadToken();
				if (token) {
					manager.setAuthToken(token);
				}
				manager.setCloudApiUrl(env.NEXT_PUBLIC_API_URL);
				const port = await manager.start();
				return { port };
			}),

		getStatus: publicProcedure
			.query(() => {
				const manager = getHostServiceManager();
				const status = manager.getStatus();
				return { status };
			}),
	});
};
