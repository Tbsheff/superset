import { LOCAL_USER_ID } from "@superset/shared/constants";
import { createCaller } from "@superset/trpc";
import {
	isGhAuthenticated,
	performGitHubSync,
} from "../../lib/trpc/routers/data/github-sync";

const SYNC_INTERVAL = 15 * 60 * 1000; // 15 minutes
const BOOT_DELAY = 10_000; // 10 seconds

let linearSyncRunning = false;
let githubSyncRunning = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
let bootTimeoutId: ReturnType<typeof setTimeout> | null = null;

function getCaller() {
	return createCaller({
		userId: LOCAL_USER_ID,
		headers: new Headers(),
	});
}

async function syncLinear() {
	if (linearSyncRunning) return;
	linearSyncRunning = true;
	try {
		const connection = await getCaller().integration.linear.getConnection();
		if (!connection) return;

		const result = await getCaller().integration.linear.triggerSync();
		console.log(
			`[integration-sync] Linear sync completed: ${result.issueCount} issues`,
		);
	} catch (err) {
		console.error("[integration-sync] Linear sync failed:", err);
	} finally {
		linearSyncRunning = false;
	}
}

async function syncGitHub() {
	if (githubSyncRunning) return;
	githubSyncRunning = true;
	try {
		const { authenticated } = await isGhAuthenticated();
		if (!authenticated) return;

		const result = await performGitHubSync();
		console.log(
			`[integration-sync] GitHub sync completed: ${result.repoCount} repos, ${result.prCount} PRs`,
		);
	} catch (err) {
		console.error("[integration-sync] GitHub sync failed:", err);
	} finally {
		githubSyncRunning = false;
	}
}

function runSync() {
	void syncLinear();
	void syncGitHub();
}

export function startIntegrationSync() {
	bootTimeoutId = setTimeout(runSync, BOOT_DELAY);
	intervalId = setInterval(runSync, SYNC_INTERVAL);
}

export function stopIntegrationSync() {
	if (bootTimeoutId) clearTimeout(bootTimeoutId);
	if (intervalId) clearInterval(intervalId);
	bootTimeoutId = null;
	intervalId = null;
}
