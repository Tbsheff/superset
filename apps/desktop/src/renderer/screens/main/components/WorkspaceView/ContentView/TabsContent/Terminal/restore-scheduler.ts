/**
 * Restore Scheduler
 *
 * Serializes terminal restore writes so only one terminal writes its
 * multi-MB snapshot payload at a time. Without this, N terminals
 * simultaneously feeding restore data into restty's WASM parser
 * overwhelm the V8 heap (OOM at ~4GB).
 *
 * Works alongside attach-scheduler.ts which gates RPC calls —
 * this scheduler gates the actual restore data writes.
 */

type RestoreTask = {
	paneId: string;
	priority: number;
	enqueuedAt: number;
	canceled: boolean;
	run: (done: () => void) => void;
};

const MAX_CONCURRENT_RESTORES = 1;

const DEBUG_SCHEDULER =
	typeof localStorage !== "undefined" &&
	localStorage.getItem("SUPERSET_TERMINAL_DEBUG") === "1";

let inFlight = 0;
const queue: RestoreTask[] = [];

function pump(): void {
	while (inFlight < MAX_CONCURRENT_RESTORES && queue.length > 0) {
		queue.sort(
			(a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt,
		);
		const task = queue.shift();
		if (!task) return;
		if (task.canceled) {
			if (DEBUG_SCHEDULER) {
				console.log(
					`[RestoreScheduler] Skipping canceled task: ${task.paneId}`,
				);
			}
			continue;
		}

		inFlight++;

		if (DEBUG_SCHEDULER) {
			console.log(
				`[RestoreScheduler] Starting restore: ${task.paneId}, inFlight=${inFlight}, queueLength=${queue.length}`,
			);
		}

		task.run(() => {
			if (DEBUG_SCHEDULER) {
				console.log(
					`[RestoreScheduler] Restore done: ${task.paneId}, inFlight=${inFlight - 1}`,
				);
			}
			inFlight = Math.max(0, inFlight - 1);
			pump();
		});
	}
}

export function scheduleTerminalRestore({
	paneId,
	priority,
	run,
}: {
	paneId: string;
	priority: number;
	run: (done: () => void) => void;
}): () => void {
	if (DEBUG_SCHEDULER) {
		console.log(
			`[RestoreScheduler] Schedule: ${paneId}, priority=${priority}, inFlight=${inFlight}, queueLength=${queue.length}`,
		);
	}

	const task: RestoreTask = {
		paneId,
		priority,
		enqueuedAt: Date.now(),
		canceled: false,
		run,
	};

	queue.push(task);
	pump();

	return () => {
		task.canceled = true;
	};
}
