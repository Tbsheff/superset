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
				[data-diff-type="addition"] [data-role="indicator"],
				[data-line-type="addition"] [data-role="indicator"] {
					background-color: var(--diffs-addition-bar-color, #3fb950);
				}
				[data-diff-type="deletion"] [data-role="indicator"],
				[data-line-type="deletion"] [data-role="indicator"] {
					background-color: var(--diffs-deletion-bar-color, #f85149);
				}
				[data-role="file-header"] {
					background-color: #161b22 !important;
					border-bottom: 1px solid #30363d !important;
					padding: 8px 12px !important;
				}
				[data-role="file-header"] [data-role="file-name"] {
					font-weight: 600 !important;
					color: #e6edf3 !important;
				}
				[data-role="file-header"] [data-role="additions"] {
					color: #3fb950 !important;
				}
				[data-role="file-header"] [data-role="deletions"] {
					color: #f85149 !important;
				}
				[data-role="separator"],
				[data-role="hunk-separator"] {
					background-color: #161b22 !important;
					color: #8b949e !important;
					border-top: 1px solid #21262d !important;
					border-bottom: 1px solid #21262d !important;
				}
			`,
			}}
		/>
	);
}
