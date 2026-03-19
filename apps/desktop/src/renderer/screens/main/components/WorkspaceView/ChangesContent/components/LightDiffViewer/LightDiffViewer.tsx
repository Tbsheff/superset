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
					--diffs-bg-separator-override: #161b22;
				}
				[data-separator='line-info'] {
					border-top: 1px solid #21262d;
					border-bottom: 1px solid #21262d;
				}
				[data-separator-content],
				[data-expand-button] {
					background-color: #161b22 !important;
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

				/* Word-level diff highlights — more saturated inline emphasis */
				[data-diff-span] {
					border-radius: 2px;
				}
				[data-line-type='change-addition'] [data-diff-span] {
					background-color: rgba(46, 160, 67, 0.45) !important;
				}
				[data-line-type='change-deletion'] [data-diff-span] {
					background-color: rgba(248, 81, 73, 0.45) !important;
				}

				/* Line number color tints on changed lines */
				[data-line-type='change-addition'] [data-column-number] {
					color: rgba(63, 185, 80, 0.85) !important;
				}
				[data-line-type='change-deletion'] [data-column-number] {
					color: rgba(248, 81, 73, 0.85) !important;
				}

				/* Split mode: replace gap with a 1px divider line */
				[data-type='split'][data-overflow='scroll'] {
					gap: 0 !important;
				}
				[data-type='split'][data-overflow='scroll'] [data-additions] {
					border-left: 1px solid #21262d;
				}

				/* File header */
				[data-diffs-header] {
					background-color: #161b22 !important;
					border-bottom: 1px solid #30363d !important;
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
					color: #f85149 !important;
				}
			`,
			}}
		/>
	);
}
