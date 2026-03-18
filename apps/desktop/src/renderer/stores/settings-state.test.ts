import { beforeEach, describe, expect, test } from "bun:test";
import { useSettingsStore } from "./settings-state";

beforeEach(() => {
	useSettingsStore.setState({
		activeSection: "account",
		activeProjectId: null,
		searchQuery: "",
		isOpen: false,
	});
});

describe("useSettingsStore", () => {
	test('initial activeSection is "account"', () => {
		const { activeSection } = useSettingsStore.getState();
		expect(activeSection).toBe("account");
	});

	test('setActiveSection accepts "remote-hosts"', () => {
		useSettingsStore.getState().setActiveSection("remote-hosts");
		expect(useSettingsStore.getState().activeSection).toBe("remote-hosts");
	});

	test('openSettings with "remote-hosts" section sets activeSection correctly', () => {
		useSettingsStore.getState().openSettings("remote-hosts");
		const { activeSection, isOpen } = useSettingsStore.getState();
		expect(activeSection).toBe("remote-hosts");
		expect(isOpen).toBe(true);
	});
});
