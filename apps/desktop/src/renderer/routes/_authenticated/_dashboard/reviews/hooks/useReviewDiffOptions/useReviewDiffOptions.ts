import type { FileDiffOptions } from "@pierre/diffs";
import type { CSSProperties } from "react";
import { useMemo } from "react";
import {
	getDiffsTheme,
	getDiffViewerStyle,
} from "renderer/screens/main/components/WorkspaceView/utils/code-theme";
import { useSettings } from "renderer/stores/settings";
import { useResolvedTheme } from "renderer/stores/theme";

interface ReviewDiffOptions {
	options: FileDiffOptions<undefined>;
	style: CSSProperties;
}

/**
 * Theme + render options for the PR `<PatchDiff>`, mirroring the workspace
 * `useDiffCodeViewTheme` but decoupled from the changeset/annotation pipeline.
 * The token limits keep huge generated files (lockfiles, bundles) from blocking
 * the worker pool that @pierre/diffs uses for off-main-thread highlighting.
 */
export function useReviewDiffOptions(): ReviewDiffOptions {
	const diffStyle = useSettings((s) => s.diffStyle);
	const expandUnchanged = useSettings((s) => s.expandUnchanged);
	const activeTheme = useResolvedTheme();

	const style = useMemo<CSSProperties>(
		() => getDiffViewerStyle(activeTheme, {}),
		[activeTheme],
	);

	const options = useMemo<FileDiffOptions<undefined>>(
		() => ({
			diffStyle,
			expandUnchanged,
			overflow: "wrap",
			stickyHeader: true,
			theme: getDiffsTheme(activeTheme),
			themeType: activeTheme.type,
			tokenizeMaxLineLength: 5_000,
			tokenizeMaxLength: 200_000,
			maxLineDiffLength: 5_000,
		}),
		[activeTheme, diffStyle, expandUnchanged],
	);

	return { options, style };
}
