import * as Sentry from "@sentry/nextjs";
import { bootstrapLinearToken, bootstrapLocalUser } from "./bootstrap-local";

export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		await import("../sentry.server.config");
		await bootstrapLocalUser();
		await bootstrapLinearToken();
	}

	if (process.env.NEXT_RUNTIME === "edge") {
		await import("../sentry.edge.config");
	}
}

export const onRequestError = Sentry.captureRequestError;
