import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { env } from "../env";

let ratelimit: Ratelimit | null = null;

if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) {
	const redis = new Redis({
		url: env.KV_REST_API_URL,
		token: env.KV_REST_API_TOKEN,
	});

	ratelimit = new Ratelimit({
		redis,
		limiter: Ratelimit.slidingWindow(10, "1 h"),
		prefix: "ratelimit:invitation",
	});
}

// Returns a rate limit check — no-op if Redis is not configured
export async function invitationRateLimit(
	identifier: string,
): Promise<{ success: boolean }> {
	if (!ratelimit) return { success: true };
	return ratelimit.limit(identifier);
}
