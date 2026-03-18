import { useEffect, useState } from "react";
import { getFileIcon, prefetchFileIconManifest } from "./file-icons";

interface FileIconProps {
	fileName: string;
	isDirectory?: boolean;
	isOpen?: boolean;
	className?: string;
}

export function FileIcon({
	fileName,
	isDirectory = false,
	isOpen = false,
	className,
}: FileIconProps) {
	const result = getFileIcon(fileName, isDirectory, isOpen);
	const [, setReady] = useState(result !== null);

	// If manifest isn't loaded yet, prefetch and re-render once ready
	useEffect(() => {
		if (result !== null) return;
		let cancelled = false;
		prefetchFileIconManifest().then(() => {
			if (!cancelled) setReady(true);
		});
		return () => {
			cancelled = true;
		};
	}, [result]);

	if (!result) return null;

	return (
		<img src={result.src} alt="" draggable={false} className={className} />
	);
}
