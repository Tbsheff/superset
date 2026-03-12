import { getHostServiceManager } from "main/lib/host-service-manager";
import { publicProcedure, router } from "../..";
import { loadToken } from "../auth/utils/auth-functions";

export const createHostServiceManagerRouter = () => {
	return router({
		getLocalPort: publicProcedure.query(async () => {
			const manager = getHostServiceManager();
			const { token } = await loadToken();
			if (token) {
				manager.setAuthToken(token);
			}
			const port = await manager.start();
			return { port };
		}),

		getStatus: publicProcedure.query(() => {
			const manager = getHostServiceManager();
			const status = manager.getStatus();
			return { status };
		}),
	});
};
