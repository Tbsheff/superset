import { publicProcedure, router } from "../..";

export const createCacheRouter = () => {
	return router({
		clearElectricCache: publicProcedure.mutation(async () => {
			// No-op: data sync now uses IPC instead of HTTP polling
			return { success: true };
		}),
	});
};

export type CacheRouter = ReturnType<typeof createCacheRouter>;
