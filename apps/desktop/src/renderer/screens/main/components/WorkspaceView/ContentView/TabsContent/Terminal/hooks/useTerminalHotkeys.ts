import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useEffect, useState } from "react";
import { useAppHotkey } from "renderer/stores/hotkeys";
import type { ResttyAdapter } from "../restty/ResttyAdapter";
import { scrollToBottom } from "../utils";

export interface UseTerminalHotkeysOptions {
	isFocused: boolean;
	adapterRef: MutableRefObject<ResttyAdapter | null>;
}

export interface UseTerminalHotkeysReturn {
	isSearchOpen: boolean;
	setIsSearchOpen: Dispatch<SetStateAction<boolean>>;
}

export function useTerminalHotkeys({
	isFocused,
	adapterRef,
}: UseTerminalHotkeysOptions): UseTerminalHotkeysReturn {
	const [isSearchOpen, setIsSearchOpen] = useState(false);

	useEffect(() => {
		if (!isFocused) {
			setIsSearchOpen(false);
		}
	}, [isFocused]);

	useEffect(() => {
		const adapter = adapterRef.current;
		if (!adapter) return;
		if (isFocused) {
			adapter.focus();
		}
	}, [isFocused, adapterRef]);

	useAppHotkey(
		"FIND_IN_TERMINAL",
		() => setIsSearchOpen((prev) => !prev),
		{ enabled: isFocused, preventDefault: true },
		[isFocused],
	);

	useAppHotkey(
		"SCROLL_TO_BOTTOM",
		() => {
			if (adapterRef.current) {
				scrollToBottom(adapterRef.current);
			}
		},
		{ enabled: isFocused, preventDefault: true },
		[isFocused],
	);

	return { isSearchOpen, setIsSearchOpen };
}
