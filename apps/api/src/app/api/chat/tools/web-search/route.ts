import { auth } from "@superset/auth/server";
import { tavily } from "@tavily/core";
import { env } from "@/env";

// Simple in-memory rate limiter (no Redis dependency)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000; // 1 day

function checkRateLimit(identifier: string): boolean {
	const now = Date.now();
	const entry = rateLimitMap.get(identifier);

	if (!entry || now > entry.resetAt) {
		rateLimitMap.set(identifier, { count: 1, resetAt: now + WINDOW_MS });
		return true;
	}

	if (entry.count >= RATE_LIMIT) {
		return false;
	}

	entry.count++;
	return true;
}

export async function POST(request: Request): Promise<Response> {
	const session = await auth.api.getSession({
		headers: request.headers,
	});

	if (!session?.user) {
		return new Response("Unauthorized", { status: 401 });
	}

	if (!checkRateLimit(session.user.id)) {
		return Response.json(
			{ error: "Rate limit exceeded. Try again later." },
			{ status: 429 },
		);
	}

	let body: { query?: string; maxResults?: number };
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	if (!body.query || typeof body.query !== "string") {
		return Response.json(
			{ error: "Missing or invalid 'query' field" },
			{ status: 400 },
		);
	}

	const rawMax = body.maxResults;
	const maxResults =
		typeof rawMax === "number" && Number.isFinite(rawMax)
			? Math.min(Math.max(rawMax, 1), 10)
			: 5;

	if (!env.TAVILY_API_KEY) {
		return Response.json(
			{ error: "Web search is not configured" },
			{ status: 503 },
		);
	}

	try {
		const client = tavily({ apiKey: env.TAVILY_API_KEY });
		const response = await client.search(body.query, { maxResults });

		return Response.json({
			results: response.results.map((r) => ({
				title: r.title,
				url: r.url,
				content: r.content,
			})),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Search failed";
		return Response.json({ error: message }, { status: 502 });
	}
}
