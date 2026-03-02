import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useCallback, useEffect, useRef, useState } from "react";
import { HiChevronDown, HiChevronUp, HiMiniXMark } from "react-icons/hi2";
import { PiTextAa } from "react-icons/pi";
import type { SearchShim } from "../restty/SearchShim";

interface TerminalSearchProps {
	searchShim: SearchShim | null;
	isOpen: boolean;
	onClose: () => void;
}

export function TerminalSearch({
	searchShim,
	isOpen,
	onClose,
}: TerminalSearchProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [matchInfo, setMatchInfo] = useState<{
		current: number;
		total: number;
	} | null>(null);
	const [caseSensitive, setCaseSensitive] = useState(false);

	// Focus input when search opens
	useEffect(() => {
		if (isOpen && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [isOpen]);

	// Clear search when closing
	useEffect(() => {
		if (!isOpen && searchShim) {
			searchShim.clearSearch();
		}
	}, [isOpen, searchShim]);

	const handleSearch = useCallback(
		(direction: "next" | "previous") => {
			if (!searchShim || !query) return;

			const result =
				direction === "next"
					? searchShim.findNext(query, { caseSensitive })
					: searchShim.findPrevious(query, { caseSensitive });

			if (result) {
				setMatchInfo({
					current: result.matchIndex + 1,
					total: result.totalMatches,
				});
			} else {
				setMatchInfo({ current: 0, total: 0 });
			}
		},
		[searchShim, query, caseSensitive],
	);

	const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const newQuery = e.target.value;
		setQuery(newQuery);

		if (searchShim && newQuery) {
			const result = searchShim.findNext(newQuery, { caseSensitive });
			if (result) {
				setMatchInfo({
					current: result.matchIndex + 1,
					total: result.totalMatches,
				});
			} else {
				setMatchInfo({ current: 0, total: 0 });
			}
		} else {
			setMatchInfo(null);
			searchShim?.clearSearch();
		}
	};

	const toggleCaseSensitive = () => {
		setCaseSensitive((prev) => !prev);
	};

	// Re-run search when case sensitivity changes
	useEffect(() => {
		if (searchShim && query) {
			const result = searchShim.findNext(query, { caseSensitive });
			if (result) {
				setMatchInfo({
					current: result.matchIndex + 1,
					total: result.totalMatches,
				});
			} else {
				setMatchInfo({ current: 0, total: 0 });
			}
		}
	}, [searchShim, query, caseSensitive]);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			onClose();
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (e.shiftKey) {
				handleSearch("previous");
			} else {
				handleSearch("next");
			}
		}
	};

	const handleClose = () => {
		setQuery("");
		setMatchInfo(null);
		onClose();
	};

	if (!isOpen) return null;

	return (
		<div className="absolute top-1 right-1 z-10 flex items-center max-w-[calc(100%-0.5rem)] rounded bg-popover/95 pl-2 pr-0.5 shadow-lg ring-1 ring-border/40 backdrop-blur">
			<input
				ref={inputRef}
				type="text"
				value={query}
				onChange={handleInputChange}
				onKeyDown={handleKeyDown}
				placeholder="Find"
				className="h-6 min-w-0 w-28 flex-shrink bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
			/>
			{matchInfo !== null && query && (
				<span className="text-xs text-muted-foreground whitespace-nowrap px-1">
					{matchInfo.total === 0
						? "No results"
						: `${matchInfo.current}/${matchInfo.total}`}
				</span>
			)}
			<div className="flex items-center shrink-0">
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={toggleCaseSensitive}
							className={`rounded p-1 transition-colors ${
								caseSensitive
									? "bg-primary/20 text-foreground"
									: "text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground"
							}`}
						>
							<PiTextAa className="size-3.5" />
						</button>
					</TooltipTrigger>
					<TooltipContent side="bottom">Match case</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={() => handleSearch("previous")}
							className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground"
						>
							<HiChevronUp className="size-3.5" />
						</button>
					</TooltipTrigger>
					<TooltipContent side="bottom">Previous (Shift+Enter)</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={() => handleSearch("next")}
							className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground"
						>
							<HiChevronDown className="size-3.5" />
						</button>
					</TooltipTrigger>
					<TooltipContent side="bottom">Next (Enter)</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={handleClose}
							className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground"
						>
							<HiMiniXMark className="size-3.5" />
						</button>
					</TooltipTrigger>
					<TooltipContent side="bottom">Close (Esc)</TooltipContent>
				</Tooltip>
			</div>
		</div>
	);
}
