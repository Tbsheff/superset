import { bootstrapLinearToken, bootstrapLocalUser } from "./bootstrap-local";

export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		await bootstrapLocalUser();
		await bootstrapLinearToken();
	}
}
