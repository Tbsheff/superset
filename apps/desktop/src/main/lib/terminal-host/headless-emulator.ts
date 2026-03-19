/**
 * Headless Terminal Emulator
 *
 * Re-exports WasmHeadlessEmulator as HeadlessEmulator for backwards compatibility.
 * The xterm/headless + @xterm/addon-serialize implementation has been replaced
 * with restty's libghostty-vt WASM module.
 */

export {
	WasmHeadlessEmulator as HeadlessEmulator,
	type WasmHeadlessEmulatorOptions as HeadlessEmulatorOptions,
	applySnapshot,
	modesEqual,
} from "./wasm-headless-emulator";
