import { describe, expect, it, mock } from "bun:test";

/**
 * Tests for ResttyAdapter's chunked write buffer.
 *
 * Since ResttyAdapter depends on restty's WASM module which can't be loaded
 * in a plain bun:test environment, we test the chunking logic by simulating
 * the _drainQueue pattern with the same constants and algorithm.
 */

const CHUNK_SIZE = 16_384; // Must match ResttyAdapter.CHUNK_SIZE

interface WriteQueueItem {
	data: string;
	callback?: () => void;
}

/**
 * Simulate the drain queue algorithm from ResttyAdapter.
 * Returns the chunks that would be fed to feedData() in order.
 */
function simulateDrainQueue(input: string): string[] {
	const chunks: string[] = [];
	const queue: WriteQueueItem[] = [{ data: input }];

	while (queue.length > 0) {
		const item = queue[0]!;
		const chunk = item.data.substring(0, CHUNK_SIZE);
		item.data = item.data.substring(CHUNK_SIZE);
		chunks.push(chunk);

		if (item.data.length === 0) {
			queue.shift();
		}
	}

	return chunks;
}

describe("ResttyAdapter chunked write buffer", () => {
	it("passes small data through as single chunk", () => {
		const data = "hello world";
		const chunks = simulateDrainQueue(data);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toBe(data);
	});

	it("passes data exactly at CHUNK_SIZE as single chunk", () => {
		const data = "x".repeat(CHUNK_SIZE);
		const chunks = simulateDrainQueue(data);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toBe(data);
	});

	it("splits data exceeding CHUNK_SIZE into multiple chunks", () => {
		const data = "A".repeat(CHUNK_SIZE + 100);
		const chunks = simulateDrainQueue(data);
		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toHaveLength(CHUNK_SIZE);
		expect(chunks[1]).toHaveLength(100);
		expect(chunks.join("")).toBe(data);
	});

	it("splits large restore payload (3MB) into ~187 chunks", () => {
		const size = 3 * 1024 * 1024; // 3MB
		const data = "B".repeat(size);
		const chunks = simulateDrainQueue(data);
		const expectedChunks = Math.ceil(size / CHUNK_SIZE);
		expect(chunks).toHaveLength(expectedChunks);
		expect(chunks.join("")).toBe(data);
		// Each chunk except possibly the last should be exactly CHUNK_SIZE
		for (let i = 0; i < chunks.length - 1; i++) {
			expect(chunks[i]).toHaveLength(CHUNK_SIZE);
		}
	});

	it("preserves data integrity for ANSI escape sequences", () => {
		// Simulate a restore payload with ANSI sequences
		const ansiLine = "\x1b[38;2;255;128;0mHello World\x1b[0m\r\n";
		const repeats = Math.ceil((CHUNK_SIZE * 2.5) / ansiLine.length);
		const data = ansiLine.repeat(repeats);
		const chunks = simulateDrainQueue(data);
		expect(chunks.join("")).toBe(data);
		expect(chunks.length).toBeGreaterThan(1);
	});

	it("handles empty string", () => {
		const chunks = simulateDrainQueue("");
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toBe("");
	});

	it("fires callback only after full item is consumed", () => {
		const callbackFired = mock(() => {});
		const data = "C".repeat(CHUNK_SIZE * 3);
		const queue: WriteQueueItem[] = [{ data, callback: callbackFired }];
		let chunksProcessed = 0;

		while (queue.length > 0) {
			const item = queue[0]!;
			const chunk = item.data.substring(0, CHUNK_SIZE);
			item.data = item.data.substring(CHUNK_SIZE);
			chunksProcessed++;

			if (item.data.length === 0) {
				queue.shift();
				item.callback?.();
			}
		}

		expect(chunksProcessed).toBe(3);
		expect(callbackFired).toHaveBeenCalledTimes(1);
	});
});
