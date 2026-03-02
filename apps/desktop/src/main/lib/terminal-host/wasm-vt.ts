/**
 * WASM VT Loader
 *
 * Loads restty's embedded libghostty-vt WASM module for headless use in Node.js.
 * The WASM binary is embedded as base64 in restty's JS bundle, so no external
 * .wasm file is needed.
 *
 * This module provides a singleton `ResttyWasm` instance shared across all
 * terminal sessions in the daemon process.
 */

import type { ResttyWasm } from "restty/internal";

let wasmInstance: ResttyWasm | null = null;
let loadPromise: Promise<ResttyWasm> | null = null;

/**
 * Load the ResttyWasm singleton. Returns the cached instance on subsequent calls.
 * Thread-safe via promise deduplication.
 */
export async function loadWasmVt(): Promise<ResttyWasm> {
	if (wasmInstance) return wasmInstance;

	if (!loadPromise) {
		loadPromise = doLoad();
	}

	return loadPromise;
}

async function doLoad(): Promise<ResttyWasm> {
	// Dynamic import to avoid pulling restty into the main bundle graph
	// until actually needed. The WASM module is ~2MB base64.
	const { loadResttyWasm } = await import("restty/internal");

	wasmInstance = await loadResttyWasm({
		log: (message) => {
			if (process.env.SUPERSET_TERMINAL_EMULATOR_DEBUG === "1") {
				console.log(`[wasm-vt] ${message}`);
			}
		},
	});

	return wasmInstance;
}

/**
 * Get the loaded ResttyWasm instance synchronously.
 * Throws if not yet loaded — call loadWasmVt() first.
 */
export function getWasmVt(): ResttyWasm {
	if (!wasmInstance) {
		throw new Error("WASM VT not loaded. Call loadWasmVt() first.");
	}
	return wasmInstance;
}
