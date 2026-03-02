/**
 * Link detection for restty terminals.
 *
 * Replaces xterm's ILinkProvider system by detecting file paths and URLs
 * directly from RenderState codepoints on hover, and handling Cmd/Ctrl+click.
 */

import {
	decodeUrlEncodedPath,
	detectFallbackLinks,
	detectLinks,
	getCurrentOS,
	type IFallbackLink,
	type IParsedLink,
	removeLinkSuffix,
} from "@superset/shared/terminal-link-parsing";
import type { RenderState } from "restty/internal";

const URL_PATTERN = /\bhttps?:\/\/[^\s<>[\]'"]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

interface ActiveLink {
	startCol: number;
	endCol: number;
	row: number;
	type: "file" | "url";
	text: string;
	parsed?: IParsedLink;
	fallback?: IFallbackLink;
}

export interface ResttyLinkDetectorOptions {
	getRenderState: () => RenderState | null;
	getCellDimensions: () => { width: number; height: number } | null;
	onFileLinkClick: (
		path: string,
		line?: number,
		column?: number,
		lineEnd?: number,
		columnEnd?: number,
	) => void;
	onUrlClick: (url: string) => void;
	container: HTMLElement;
}

export class ResttyLinkDetector {
	private readonly getRenderState: () => RenderState | null;
	private readonly getCellDimensions: () => {
		width: number;
		height: number;
	} | null;
	private readonly onFileLinkClick: ResttyLinkDetectorOptions["onFileLinkClick"];
	private readonly onUrlClick: (url: string) => void;
	private readonly container: HTMLElement;

	private activeLink: ActiveLink | null = null;
	private overlay: HTMLDivElement | null = null;

	private readonly handleMouseMove: (e: MouseEvent) => void;
	private readonly handleClick: (e: MouseEvent) => void;
	private readonly handleMouseOut: () => void;

	constructor(opts: ResttyLinkDetectorOptions) {
		this.getRenderState = opts.getRenderState;
		this.getCellDimensions = opts.getCellDimensions;
		this.onFileLinkClick = opts.onFileLinkClick;
		this.onUrlClick = opts.onUrlClick;
		this.container = opts.container;

		this.handleMouseMove = this.onMouseMove.bind(this);
		this.handleClick = this.onClick.bind(this);
		this.handleMouseOut = this.onMouseOut.bind(this);
	}

	attach(): void {
		this.container.addEventListener("mousemove", this.handleMouseMove);
		this.container.addEventListener("click", this.handleClick);
		this.container.addEventListener("mouseout", this.handleMouseOut);
	}

	detach(): void {
		this.container.removeEventListener("mousemove", this.handleMouseMove);
		this.container.removeEventListener("click", this.handleClick);
		this.container.removeEventListener("mouseout", this.handleMouseOut);
		this.clearActiveLink();
	}

	dispose(): void {
		this.detach();
	}

	// ---------------------------------------------------------------------------
	// Text extraction from RenderState
	// ---------------------------------------------------------------------------

	private extractRowText(state: RenderState, row: number): string {
		const { cols, codepoints } = state;
		if (!codepoints || row < 0 || row >= state.rows) return "";

		const offset = row * cols;
		const chars: string[] = [];
		for (let c = 0; c < cols; c++) {
			const cp = codepoints[offset + c];
			if (cp === 0) {
				chars.push(" ");
			} else {
				chars.push(String.fromCodePoint(cp));
			}
		}

		// Trim trailing spaces to match xterm's translateToString(true)
		return chars.join("").replace(/\s+$/, "");
	}

	// ---------------------------------------------------------------------------
	// Cell coordinate helpers
	// ---------------------------------------------------------------------------

	private getCellCoords(e: MouseEvent): { col: number; row: number } | null {
		const cellDims = this.getCellDimensions();
		if (!cellDims || cellDims.width <= 0 || cellDims.height <= 0) return null;

		const rect = this.container.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;

		return {
			col: Math.floor(x / cellDims.width),
			row: Math.floor(y / cellDims.height),
		};
	}

	// ---------------------------------------------------------------------------
	// Link detection
	// ---------------------------------------------------------------------------

	private detectAtPosition(row: number, col: number): ActiveLink | null {
		const state = this.getRenderState();
		if (!state) return null;

		const rowText = this.extractRowText(state, row);
		if (!rowText) return null;

		// 1. Try URL detection first
		const urlLink = this.detectUrl(rowText, row, col);
		if (urlLink) return urlLink;

		// 2. Try file-path detection via VSCode parser
		const fileLink = this.detectFilePath(rowText, row, col);
		if (fileLink) return fileLink;

		// 3. Try fallback matchers (Python errors, Rust errors, etc.)
		const fallbackLink = this.detectFallback(rowText, row, col);
		if (fallbackLink) return fallbackLink;

		return null;
	}

	private detectUrl(
		rowText: string,
		row: number,
		col: number,
	): ActiveLink | null {
		const regex = new RegExp(URL_PATTERN.source, "g");
		for (const match of rowText.matchAll(regex)) {
			const start = match.index ?? 0;
			let text = match[0];

			// Trim unbalanced parens and trailing punctuation (same as url-link-provider)
			text = trimUnbalancedParens(text);
			text = text.replace(TRAILING_PUNCTUATION, "");

			const end = start + text.length;

			if (col >= start && col < end) {
				return { startCol: start, endCol: end, row, type: "url", text };
			}
		}
		return null;
	}

	private detectFilePath(
		rowText: string,
		row: number,
		col: number,
	): ActiveLink | null {
		const os = getCurrentOS();
		const links = detectLinks(rowText, os);

		for (let parsed of links) {
			// Strip trailing punctuation for links without suffixes
			if (!parsed.suffix) {
				parsed = this.stripTrailingPunctuation(parsed, rowText);
			}

			const linkStart = parsed.prefix?.index ?? parsed.path.index;
			const linkEnd = parsed.suffix
				? parsed.suffix.suffix.index + parsed.suffix.suffix.text.length
				: parsed.path.index + parsed.path.text.length;

			// Skip URLs (handled separately)
			const pathText = parsed.path.text;
			if (isUrl(pathText, linkStart, rowText)) continue;
			if (isVersionString(pathText)) continue;
			if (/^\d+(:\d+)*$/.test(pathText)) continue;

			if (col >= linkStart && col < linkEnd) {
				return {
					startCol: linkStart,
					endCol: linkEnd,
					row,
					type: "file",
					text: rowText.substring(linkStart, linkEnd),
					parsed,
				};
			}
		}

		return null;
	}

	private detectFallback(
		rowText: string,
		row: number,
		col: number,
	): ActiveLink | null {
		const links = detectFallbackLinks(rowText);
		for (const fb of links) {
			const start = fb.index;
			const end = fb.index + fb.link.length;
			if (col >= start && col < end) {
				return {
					startCol: start,
					endCol: end,
					row,
					type: "file",
					text: fb.link,
					fallback: fb,
				};
			}
		}
		return null;
	}

	// ---------------------------------------------------------------------------
	// Event handlers
	// ---------------------------------------------------------------------------

	private onMouseMove(e: MouseEvent): void {
		// Only show link hover when Cmd/Ctrl is held
		if (!e.metaKey && !e.ctrlKey) {
			this.clearActiveLink();
			return;
		}

		const coords = this.getCellCoords(e);
		if (!coords) {
			this.clearActiveLink();
			return;
		}

		// If we already have an active link at this position, nothing to do
		if (
			this.activeLink &&
			this.activeLink.row === coords.row &&
			coords.col >= this.activeLink.startCol &&
			coords.col < this.activeLink.endCol
		) {
			return;
		}

		const link = this.detectAtPosition(coords.row, coords.col);
		if (link) {
			this.setActiveLink(link);
		} else {
			this.clearActiveLink();
		}
	}

	private onClick(e: MouseEvent): void {
		if (!e.metaKey && !e.ctrlKey) return;

		const coords = this.getCellCoords(e);
		if (!coords) return;

		// Use cached active link if it matches, otherwise detect fresh
		let link = this.activeLink;
		if (
			!link ||
			link.row !== coords.row ||
			coords.col < link.startCol ||
			coords.col >= link.endCol
		) {
			link = this.detectAtPosition(coords.row, coords.col);
		}

		if (!link) return;

		e.preventDefault();
		e.stopPropagation();

		if (link.type === "url") {
			this.onUrlClick(link.text);
		} else if (link.parsed) {
			this.activateFileLink(link.parsed);
		} else if (link.fallback) {
			this.activateFallbackLink(link.fallback);
		}
	}

	private onMouseOut(): void {
		this.clearActiveLink();
	}

	// ---------------------------------------------------------------------------
	// Link activation
	// ---------------------------------------------------------------------------

	private activateFileLink(parsed: IParsedLink): void {
		let cleanPath = removeLinkSuffix(parsed.path.text);
		if (!cleanPath) return;

		cleanPath = decodeUrlEncodedPath(cleanPath);

		let line = parsed.suffix?.row;
		let column = parsed.suffix?.col;
		const lineEnd = parsed.suffix?.rowEnd;
		const columnEnd = parsed.suffix?.colEnd;

		// If no suffix detected, check decoded path for line:col
		if (line === undefined) {
			const match = cleanPath.match(/:(\d+)(?::(\d+))?$/);
			if (match) {
				cleanPath = cleanPath.replace(/:(\d+)(?::(\d+))?$/, "");
				line = Number.parseInt(match[1], 10);
				if (match[2]) {
					column = Number.parseInt(match[2], 10);
				}
			}
		}

		this.onFileLinkClick(cleanPath, line, column, lineEnd, columnEnd);
	}

	private activateFallbackLink(fb: IFallbackLink): void {
		const cleanPath = decodeUrlEncodedPath(fb.path);
		if (!cleanPath) return;

		this.onFileLinkClick(cleanPath, fb.line, fb.col);
	}

	// ---------------------------------------------------------------------------
	// Overlay / visual feedback
	// ---------------------------------------------------------------------------

	private setActiveLink(link: ActiveLink): void {
		this.clearActiveLink();
		this.activeLink = link;
		this.container.style.cursor = "pointer";
		this.showOverlay(link);
	}

	private clearActiveLink(): void {
		if (!this.activeLink) return;
		this.activeLink = null;
		this.container.style.cursor = "";
		this.removeOverlay();
	}

	private showOverlay(link: ActiveLink): void {
		const cellDims = this.getCellDimensions();
		if (!cellDims) return;

		const overlay = document.createElement("div");
		overlay.style.position = "absolute";
		overlay.style.left = `${link.startCol * cellDims.width}px`;
		overlay.style.top = `${link.row * cellDims.height}px`;
		overlay.style.width = `${(link.endCol - link.startCol) * cellDims.width}px`;
		overlay.style.height = `${cellDims.height}px`;
		overlay.style.borderBottom = "1px solid currentColor";
		overlay.style.pointerEvents = "none";
		overlay.style.opacity = "0.7";
		overlay.dataset.linkOverlay = "true";

		this.container.appendChild(overlay);
		this.overlay = overlay;
	}

	private removeOverlay(): void {
		if (this.overlay) {
			this.overlay.remove();
			this.overlay = null;
		}
	}

	// ---------------------------------------------------------------------------
	// Helpers (ported from file-path-link-provider)
	// ---------------------------------------------------------------------------

	private stripTrailingPunctuation(
		parsedLink: IParsedLink,
		text: string,
	): IParsedLink {
		const pathText = parsedLink.path.text;
		const linkEnd = parsedLink.path.index + pathText.length;
		const trailingMatch = pathText.match(/([.,;:!?)]+)$/);

		if (trailingMatch) {
			const punct = trailingMatch[1];
			const afterPunct = text[linkEnd];

			if (
				afterPunct === undefined ||
				/\s/.test(afterPunct) ||
				afterPunct === '"' ||
				afterPunct === "'"
			) {
				if (punct === "." && /\.[a-zA-Z0-9]{1,4}$/.test(pathText)) {
					return parsedLink;
				}
				return {
					...parsedLink,
					path: {
						index: parsedLink.path.index,
						text: pathText.slice(0, -punct.length),
					},
				};
			}
		}

		return parsedLink;
	}
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function trimUnbalancedParens(url: string): string {
	let openCount = 0;
	let endIndex = url.length;

	for (let i = 0; i < url.length; i++) {
		if (url[i] === "(") {
			openCount++;
		} else if (url[i] === ")") {
			if (openCount > 0) {
				openCount--;
			} else {
				endIndex = i;
				break;
			}
		}
	}

	let result = url.slice(0, endIndex);
	while (result.endsWith("(")) {
		result = result.slice(0, -1);
	}

	return result;
}

function isUrl(pathText: string, linkStart: number, text: string): boolean {
	if (
		pathText.startsWith("http://") ||
		pathText.startsWith("https://") ||
		pathText.startsWith("ftp://")
	) {
		return true;
	}
	if (
		linkStart > 0 &&
		text[linkStart - 1] === ":" &&
		(pathText.startsWith("//") || pathText.startsWith("http"))
	) {
		return true;
	}
	return false;
}

function isVersionString(text: string): boolean {
	return /^v?\d+\.\d+(\.\d+)*$/.test(text);
}
