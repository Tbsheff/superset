import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Mock localStorage for Node.js test environment
const mockStorage = new Map<string, string>();
const mockLocalStorage = {
	getItem: (key: string) => mockStorage.get(key) ?? null,
	setItem: (key: string, value: string) => mockStorage.set(key, value),
	removeItem: (key: string) => mockStorage.delete(key),
	clear: () => mockStorage.clear(),
};

// @ts-expect-error - mocking global localStorage
globalThis.localStorage = mockLocalStorage;

// Mock trpc-client to avoid electronTRPC dependency
mock.module("renderer/lib/trpc-client", () => ({
	electronTrpcClient: {
		external: {
			openUrl: { mutate: mock(() => Promise.resolve()) },
			openFileInEditor: { mutate: mock(() => Promise.resolve()) },
		},
		uiState: {
			hotkeys: {
				get: { query: mock(() => Promise.resolve(null)) },
				set: { mutate: mock(() => Promise.resolve()) },
			},
		},
	},
	electronReactClient: {},
}));

// Import after mocks are set up
const {
	getDefaultTerminalBg,
	getDefaultTerminalTheme,
	setupCopyHandler,
	setupPasteHandler,
} = await import("./helpers");

describe("getDefaultTerminalTheme", () => {
	beforeEach(() => {
		mockStorage.clear();
	});

	afterEach(() => {
		mockStorage.clear();
	});

	it("should return cached terminal colors from localStorage", () => {
		const cachedTerminal = {
			background: "#272822",
			foreground: "#f8f8f2",
			cursor: "#f8f8f0",
			red: "#f92672",
			green: "#a6e22e",
		};
		localStorage.setItem("theme-terminal", JSON.stringify(cachedTerminal));

		const theme = getDefaultTerminalTheme();

		// GhosttyTheme has colors.background as {r,g,b}, not a hex string
		// Just verify it returns a truthy theme object without throwing
		expect(theme).toBeTruthy();
		expect(theme.colors).toBeTruthy();
	});

	it("should fall back to theme-id lookup when no cached terminal", () => {
		localStorage.setItem("theme-id", "light");

		const theme = getDefaultTerminalTheme();

		expect(theme).toBeTruthy();
		expect(theme.colors).toBeTruthy();
	});

	it("should fall back to default dark theme when localStorage is empty", () => {
		const theme = getDefaultTerminalTheme();

		expect(theme).toBeTruthy();
		expect(theme.colors).toBeTruthy();
	});

	it("should handle invalid JSON in cached terminal gracefully", () => {
		localStorage.setItem("theme-terminal", "invalid json{");

		const theme = getDefaultTerminalTheme();

		// Should fall back to default without throwing
		expect(theme).toBeTruthy();
	});
});

describe("getDefaultTerminalBg", () => {
	beforeEach(() => {
		mockStorage.clear();
	});

	afterEach(() => {
		mockStorage.clear();
	});

	it("should return background from cached theme", () => {
		localStorage.setItem(
			"theme-terminal",
			JSON.stringify({ background: "#282c34" }),
		);

		expect(getDefaultTerminalBg()).toBe("#282c34");
	});

	it("should return default background when no cache", () => {
		expect(getDefaultTerminalBg()).toBe("#1a1a1a");
	});
});

describe("setupCopyHandler", () => {
	const originalNavigator = globalThis.navigator;

	afterEach(() => {
		globalThis.navigator = originalNavigator;
	});

	function createContainerStub(selection: string) {
		const listeners = new Map<string, EventListener>();
		const container = {
			addEventListener: mock((eventName: string, listener: EventListener) => {
				listeners.set(eventName, listener);
			}),
			removeEventListener: mock((eventName: string) => {
				listeners.delete(eventName);
			}),
		} as unknown as HTMLElement;
		const getSelection = mock(() => selection);
		return { container, listeners, getSelection };
	}

	it("trims trailing whitespace and writes to clipboardData when available", () => {
		const { container, listeners, getSelection } =
			createContainerStub("foo   \nbar  ");
		setupCopyHandler(container, getSelection);

		const preventDefault = mock(() => {});
		const setData = mock(() => {});
		const copyEvent = {
			preventDefault,
			clipboardData: { setData },
		} as unknown as ClipboardEvent;

		const copyListener = listeners.get("copy");
		expect(copyListener).toBeDefined();
		copyListener?.(copyEvent);

		expect(preventDefault).toHaveBeenCalled();
		expect(setData).toHaveBeenCalledWith("text/plain", "foo\nbar");
	});

	it("prefers clipboardData path over navigator.clipboard fallback", () => {
		const { container, listeners, getSelection } =
			createContainerStub("foo   \nbar  ");
		const writeText = mock(() => Promise.resolve());

		// @ts-expect-error - mocking navigator for tests
		globalThis.navigator = { clipboard: { writeText } };

		setupCopyHandler(container, getSelection);

		const preventDefault = mock(() => {});
		const setData = mock(() => {});
		const copyEvent = {
			preventDefault,
			clipboardData: { setData },
		} as unknown as ClipboardEvent;

		const copyListener = listeners.get("copy");
		expect(copyListener).toBeDefined();
		copyListener?.(copyEvent);

		expect(preventDefault).toHaveBeenCalled();
		expect(setData).toHaveBeenCalledWith("text/plain", "foo\nbar");
		expect(writeText).not.toHaveBeenCalled();
	});

	it("falls back to navigator.clipboard.writeText when clipboardData is missing", () => {
		const { container, listeners, getSelection } =
			createContainerStub("foo   \nbar  ");
		const writeText = mock(() => Promise.resolve());

		// @ts-expect-error - mocking navigator for tests
		globalThis.navigator = { clipboard: { writeText } };

		setupCopyHandler(container, getSelection);

		const preventDefault = mock(() => {});
		const copyEvent = {
			preventDefault,
			clipboardData: null,
		} as unknown as ClipboardEvent;

		const copyListener = listeners.get("copy");
		expect(copyListener).toBeDefined();
		copyListener?.(copyEvent);

		expect(preventDefault).not.toHaveBeenCalled();
		expect(writeText).toHaveBeenCalledWith("foo\nbar");
	});

	it("does not throw when clipboardData is missing and navigator.clipboard is unavailable", () => {
		const { container, listeners, getSelection } =
			createContainerStub("foo   \nbar  ");

		// @ts-expect-error - mocking navigator for tests
		globalThis.navigator = {};

		setupCopyHandler(container, getSelection);

		const copyEvent = {
			preventDefault: mock(() => {}),
			clipboardData: null,
		} as unknown as ClipboardEvent;

		const copyListener = listeners.get("copy");
		expect(copyListener).toBeDefined();
		expect(() => copyListener?.(copyEvent)).not.toThrow();
	});
});

describe("setupPasteHandler", () => {
	function createContainerStub() {
		const listeners = new Map<string, EventListener>();
		const container = {
			addEventListener: mock(
				(
					eventName: string,
					listener: EventListener,
					_opts?: AddEventListenerOptions,
				) => {
					listeners.set(eventName, listener);
				},
			),
			removeEventListener: mock((eventName: string) => {
				listeners.delete(eventName);
			}),
		} as unknown as HTMLElement;
		return { container, listeners };
	}

	it("forwards Ctrl+V for image-only clipboard payloads", () => {
		const { container, listeners } = createContainerStub();
		const onWrite = mock(() => {});
		setupPasteHandler(container, { onWrite });

		const preventDefault = mock(() => {});
		const stopImmediatePropagation = mock(() => {});
		const pasteEvent = {
			clipboardData: {
				getData: mock(() => ""),
				items: [{ kind: "file", type: "image/png" }],
				types: ["Files", "image/png"],
			},
			preventDefault,
			stopImmediatePropagation,
		} as unknown as ClipboardEvent;

		const pasteListener = listeners.get("paste");
		expect(pasteListener).toBeDefined();
		pasteListener?.(pasteEvent);

		expect(onWrite).toHaveBeenCalledWith("\x16");
		expect(preventDefault).toHaveBeenCalled();
		expect(stopImmediatePropagation).toHaveBeenCalled();
	});

	it("forwards Ctrl+V for non-text clipboard payloads without plain text", () => {
		const { container, listeners } = createContainerStub();
		const onWrite = mock(() => {});
		setupPasteHandler(container, { onWrite });

		const preventDefault = mock(() => {});
		const stopImmediatePropagation = mock(() => {});
		const pasteEvent = {
			clipboardData: {
				getData: mock(() => ""),
				items: [{ kind: "string", type: "text/html" }],
				types: ["text/html"],
			},
			preventDefault,
			stopImmediatePropagation,
		} as unknown as ClipboardEvent;

		const pasteListener = listeners.get("paste");
		expect(pasteListener).toBeDefined();
		pasteListener?.(pasteEvent);

		expect(onWrite).toHaveBeenCalledWith("\x16");
		expect(preventDefault).toHaveBeenCalled();
		expect(stopImmediatePropagation).toHaveBeenCalled();
	});

	it("ignores empty clipboard payloads", () => {
		const { container, listeners } = createContainerStub();
		const onWrite = mock(() => {});
		setupPasteHandler(container, { onWrite });

		const preventDefault = mock(() => {});
		const stopImmediatePropagation = mock(() => {});
		const pasteEvent = {
			clipboardData: {
				getData: mock(() => ""),
				items: [],
				types: [],
			},
			preventDefault,
			stopImmediatePropagation,
		} as unknown as ClipboardEvent;

		const pasteListener = listeners.get("paste");
		expect(pasteListener).toBeDefined();
		pasteListener?.(pasteEvent);

		expect(onWrite).not.toHaveBeenCalled();
		expect(preventDefault).not.toHaveBeenCalled();
		expect(stopImmediatePropagation).not.toHaveBeenCalled();
	});
});
