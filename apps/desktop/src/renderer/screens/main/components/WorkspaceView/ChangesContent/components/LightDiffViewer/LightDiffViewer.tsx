import { MultiFileDiff } from "@pierre/diffs/react";
import { cn } from "@superset/ui/utils";
import type { CSSProperties } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	getDiffsTheme,
	getDiffViewerStyle,
} from "renderer/screens/main/components/WorkspaceView/utils/code-theme";
import type { DiffViewMode, FileContents } from "shared/changes-types";

interface LightDiffViewerProps {
	contents: FileContents;
	viewMode: DiffViewMode;
	hideUnchangedRegions?: boolean;
	filePath: string;
	className?: string;
	style?: CSSProperties;
}

export function LightDiffViewer({
	contents,
	viewMode,
	hideUnchangedRegions,
	filePath,
	className,
	style,
}: LightDiffViewerProps) {
	const { data: fontSettings } = electronTrpc.settings.getFontSettings.useQuery(
		undefined,
		{
			staleTime: 30_000,
		},
	);
	const shikiTheme = getDiffsTheme();
	const parsedEditorFontSize =
		typeof fontSettings?.editorFontSize === "number"
			? fontSettings.editorFontSize
			: typeof fontSettings?.editorFontSize === "string"
				? Number.parseFloat(fontSettings.editorFontSize)
				: Number.NaN;
	const diffStyle = getDiffViewerStyle({
		fontFamily: fontSettings?.editorFontFamily ?? undefined,
		fontSize: Number.isFinite(parsedEditorFontSize)
			? parsedEditorFontSize
			: undefined,
	});

	return (
		<MultiFileDiff
			oldFile={{ name: filePath, contents: contents.original }}
			newFile={{ name: filePath, contents: contents.modified }}
			className={cn(className)}
			style={{
				...diffStyle,
				...style,
			}}
			options={{
				diffStyle: viewMode === "side-by-side" ? "split" : "unified",
				expandUnchanged: !hideUnchangedRegions,
				theme: shikiTheme,
				themeType: "dark",
				overflow: "wrap",
				disableFileHeader: true,
				diffIndicators: "bars",
				hunkSeparators: "line-info",
				lineDiffType: "word",
				unsafeCSS: `
				* { user-select: text; -webkit-user-select: text; }

				/* Separator polish */
				[data-separator] {
					--diffs-bg-separator-override: #1a1716;
				}
				[data-separator='line-info'] {
					border-top: 1px solid #2a2827;
					border-bottom: 1px solid #2a2827;
				}
				[data-separator-content],
				[data-expand-button] {
					background-color: #1a1716 !important;
					color: #6e7681 !important;
					font-size: 12px !important;
				}
				[data-expand-button] {
					opacity: 0.7;
					transition: opacity 150ms ease;
				}
				[data-expand-button]:hover {
					opacity: 1;
					color: #e6edf3 !important;
				}

				/* Word-level diff highlights — border-radius for inline emphasis */
				[data-diff-span] {
					border-radius: 2px;
				}

				/* Split mode: replace gap with a 1px divider line */
				[data-type='split'][data-overflow='scroll'] {
					gap: 0 !important;
				}
				[data-type='split'][data-overflow='scroll'] [data-additions] {
					border-left: 1px solid #2a2827;
				}

				/* File header */
				[data-diffs-header] {
					background-color: #1a1716 !important;
					border-bottom: 1px solid #2a2827 !important;
					padding: 8px 12px !important;
				}
				[data-diffs-header] [data-title] {
					font-weight: 600 !important;
					color: #e6edf3 !important;
				}
				[data-diffs-header] [data-additions-count] {
					color: #3fb950 !important;
				}
				[data-diffs-header] [data-deletions-count] {
					color: #d4614a !important;
				}
			`,
			}}
		/>
	);
}
