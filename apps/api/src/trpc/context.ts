import { LOCAL_USER_ID } from "@superset/shared/constants";
import { createTRPCContext } from "@superset/trpc";

export const createContext = async ({
	req,
}: {
	req: Request;
	resHeaders: Headers;
}) => {
	return createTRPCContext({
		userId: LOCAL_USER_ID,
		headers: req.headers,
	});
};
