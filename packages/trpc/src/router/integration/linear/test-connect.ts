/**
 * Quick test script to verify Linear SDK connectivity.
 * Usage: bun run packages/trpc/src/router/integration/linear/test-connect.ts YOUR_LINEAR_API_TOKEN
 */
import { LinearClient } from "@linear/sdk";

const token = process.argv[2];
if (!token) {
	console.error("Usage: bun run <this-file> <linear-api-token>");
	process.exit(1);
}

console.log("Token length:", token.length);
console.log("Token prefix:", token.substring(0, 8));

// Test 1: Direct fetch (no SDK)
console.log("\n--- Test 1: Direct fetch to Linear GraphQL API ---");
try {
	const res = await fetch("https://api.linear.app/graphql", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: token,
		},
		body: JSON.stringify({ query: "{ viewer { id name email } }" }),
	});
	console.log("Status:", res.status);
	const body = await res.json();
	console.log("Response:", JSON.stringify(body, null, 2));
} catch (err) {
	console.error("Fetch error:", err);
}

// Test 2: Linear SDK
console.log("\n--- Test 2: Linear SDK ---");
try {
	const client = new LinearClient({ apiKey: token });
	console.log("Client created, calling client.viewer...");
	const viewer = await client.viewer;
	console.log("Viewer:", viewer.name, viewer.email);
	const org = await viewer.organization;
	console.log("Org:", org.name, org.id);
} catch (err) {
	console.error("SDK error:", err);
}

console.log("\nDone.");
