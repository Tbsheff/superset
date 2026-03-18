import { describe, expect, it, test } from "bun:test";
import {
	getMatchCountBySection,
	getMatchingItemsForSection,
	isItemVisible,
	SETTING_ITEM_ID,
	SETTINGS_ITEMS,
	type SettingsItem,
	searchSettings,
} from "./settings-search";

function getIds(items: SettingsItem[]): string[] {
	return items.map((item) => item.id);
}

describe("settings search - font settings", () => {
	it('searching "font" returns both APPEARANCE_EDITOR_FONT and APPEARANCE_TERMINAL_FONT', () => {
		const results = searchSettings("font");
		const ids = getIds(results);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_EDITOR_FONT);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_TERMINAL_FONT);
	});

	it('searching "terminal font" returns APPEARANCE_TERMINAL_FONT', () => {
		const results = searchSettings("terminal font");
		const ids = getIds(results);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_TERMINAL_FONT);
	});

	it('searching "editor" returns APPEARANCE_EDITOR_FONT', () => {
		const results = searchSettings("editor");
		const ids = getIds(results);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_EDITOR_FONT);
	});

	it('searching "monospace" returns both font items', () => {
		const results = searchSettings("monospace");
		const ids = getIds(results);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_EDITOR_FONT);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_TERMINAL_FONT);
	});

	it('searching "Editor Font" is case-insensitive', () => {
		const results = searchSettings("Editor Font");
		const ids = getIds(results);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_EDITOR_FONT);
	});

	it("empty search returns all settings items", () => {
		const results = searchSettings("");
		expect(results.length).toBeGreaterThan(0);
		const ids = getIds(results);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_EDITOR_FONT);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_TERMINAL_FONT);
	});

	it("font items have correct section", () => {
		const results = searchSettings("font");
		const editorFont = results.find(
			(r) => r.id === SETTING_ITEM_ID.APPEARANCE_EDITOR_FONT,
		);
		const terminalFont = results.find(
			(r) => r.id === SETTING_ITEM_ID.APPEARANCE_TERMINAL_FONT,
		);

		expect(editorFont?.section).toBe("appearance");
		expect(terminalFont?.section).toBe("appearance");
	});
});

describe("SETTINGS_ITEMS", () => {
	test("includes remote-hosts-list item with correct section", () => {
		const item = SETTINGS_ITEMS.find(
			(i) => i.id === SETTING_ITEM_ID.REMOTE_HOSTS_LIST,
		);
		expect(item).toBeDefined();
		expect(item?.section).toBe("remote-hosts");
	});
});

describe("SETTING_ITEM_ID", () => {
	test("has REMOTE_HOSTS_LIST", () => {
		expect(SETTING_ITEM_ID.REMOTE_HOSTS_LIST).toBe("remote-hosts-list");
	});
});

describe("searchSettings - remote hosts", () => {
	test('finds remote hosts when searching "ssh"', () => {
		const results = searchSettings("ssh");
		const ids = results.map((i) => i.id);
		expect(ids).toContain(SETTING_ITEM_ID.REMOTE_HOSTS_LIST);
	});

	test('finds remote hosts when searching "remote"', () => {
		const results = searchSettings("remote");
		const ids = results.map((i) => i.id);
		expect(ids).toContain(SETTING_ITEM_ID.REMOTE_HOSTS_LIST);
	});

	test('finds remote hosts when searching "server"', () => {
		const results = searchSettings("server");
		const ids = results.map((i) => i.id);
		expect(ids).toContain(SETTING_ITEM_ID.REMOTE_HOSTS_LIST);
	});

	test('finds remote hosts when searching "connection"', () => {
		const results = searchSettings("connection");
		const ids = results.map((i) => i.id);
		expect(ids).toContain(SETTING_ITEM_ID.REMOTE_HOSTS_LIST);
	});
});

describe("getMatchCountBySection", () => {
	test('returns count > 0 for remote-hosts section when searching "ssh"', () => {
		const counts = getMatchCountBySection("ssh");
		expect((counts["remote-hosts"] ?? 0) > 0).toBe(true);
	});
});

describe("getMatchingItemsForSection", () => {
	test('returns remote-hosts items when searching "ssh"', () => {
		const items = getMatchingItemsForSection("ssh", "remote-hosts");
		expect(items.length).toBeGreaterThan(0);
		expect(items.every((i) => i.section === "remote-hosts")).toBe(true);
	});
});

describe("isItemVisible", () => {
	test("returns true when visibleItems is null", () => {
		expect(isItemVisible(SETTING_ITEM_ID.REMOTE_HOSTS_LIST, null)).toBe(true);
	});

	test("returns true when item is in visibleItems", () => {
		expect(
			isItemVisible(SETTING_ITEM_ID.REMOTE_HOSTS_LIST, [
				SETTING_ITEM_ID.REMOTE_HOSTS_LIST,
			]),
		).toBe(true);
	});

	test("returns false when item is not in visibleItems", () => {
		expect(
			isItemVisible(SETTING_ITEM_ID.REMOTE_HOSTS_LIST, [
				SETTING_ITEM_ID.ACCOUNT_PROFILE,
			]),
		).toBe(false);
	});
});
