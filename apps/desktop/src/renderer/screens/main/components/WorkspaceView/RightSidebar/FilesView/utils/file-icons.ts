import { resolveFileIconAssetUrl } from "./resolveFileIconAssetUrl";

interface FileIconManifest {
	fileNames: Record<string, string>;
	fileExtensions: Record<string, string>;
	folderNames: Record<string, string>;
	folderNamesExpanded: Record<string, string>;
	defaultIcon: string;
	defaultFolderIcon: string;
	defaultFolderOpenIcon: string;
}

// Lazy-load the 427KB manifest JSON — only parsed/loaded on first call.
// Vite code-splits dynamic import() so this chunk isn't in the main bundle.
let _manifestPromise: Promise<FileIconManifest> | null = null;
let _manifest: FileIconManifest | null = null;

function loadManifest(): Promise<FileIconManifest> {
	if (!_manifestPromise) {
		_manifestPromise = import("resources/public/file-icons/manifest.json").then(
			(m) => {
				_manifest = m.default as FileIconManifest;
				return _manifest;
			},
		);
	}
	return _manifestPromise;
}

/** Prefetch the manifest so it's ready before first render. */
export function prefetchFileIconManifest(): Promise<FileIconManifest> {
	return loadManifest();
}

interface FileIconResult {
	src: string;
}

export function getFileIcon(
	fileName: string,
	isDirectory: boolean,
	isOpen = false,
): FileIconResult | null {
	// Kick off lazy load if not started yet; return null until ready
	if (!_manifest) {
		loadManifest();
		return null;
	}

	const manifest = _manifest;

	if (isDirectory) {
		const baseName = fileName.toLowerCase();
		if (isOpen && manifest.folderNamesExpanded[baseName]) {
			return {
				src: resolveFileIconAssetUrl(manifest.folderNamesExpanded[baseName]),
			};
		}
		if (manifest.folderNames[baseName]) {
			const iconName = isOpen
				? (manifest.folderNamesExpanded[baseName] ??
					manifest.folderNames[baseName])
				: manifest.folderNames[baseName];
			return { src: resolveFileIconAssetUrl(iconName) };
		}
		return {
			src: resolveFileIconAssetUrl(
				isOpen ? manifest.defaultFolderOpenIcon : manifest.defaultFolderIcon,
			),
		};
	}

	// Check exact filename match (case-sensitive first, then lowercase)
	const fileNameLower = fileName.toLowerCase();
	if (manifest.fileNames[fileName]) {
		return { src: resolveFileIconAssetUrl(manifest.fileNames[fileName]) };
	}
	if (manifest.fileNames[fileNameLower]) {
		return { src: resolveFileIconAssetUrl(manifest.fileNames[fileNameLower]) };
	}

	// Check file extensions (try compound extensions first, e.g. "d.ts" before "ts")
	const dotIndex = fileName.indexOf(".");
	if (dotIndex !== -1) {
		const afterFirstDot = fileName.slice(dotIndex + 1).toLowerCase();
		const segments = afterFirstDot.split(".");
		for (let i = 0; i < segments.length; i++) {
			const ext = segments.slice(i).join(".");
			if (manifest.fileExtensions[ext]) {
				return { src: resolveFileIconAssetUrl(manifest.fileExtensions[ext]) };
			}
		}
	}

	return { src: resolveFileIconAssetUrl(manifest.defaultIcon) };
}
