import { Layers } from "lucide-react";

interface AllIssuesIconProps {
	color?: string;
	className?: string;
}

export function AllIssuesIcon({
	color = "currentColor",
	className,
}: AllIssuesIconProps) {
	return <Layers className={className} style={{ color }} />;
}
