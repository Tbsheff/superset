import { createCaller } from "../../../index";

const caller = createCaller({
	userId: "00000000-0000-0000-0000-000000000001",
	headers: new Headers(),
});

try {
	console.log("Fetching teams...");
	const teams = await caller.integration.linear.getTeams();
	console.log("Teams:", JSON.stringify(teams, null, 2));

	console.log("\nFetching connection...");
	const connection = await caller.integration.linear.getConnection();
	console.log("Connection:", JSON.stringify(connection, null, 2));
} catch (e) {
	console.error("Error:", e);
}
