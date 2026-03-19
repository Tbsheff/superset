import { Layers } from "lucide-react";

interface AllIssuesIconProps {
	color?: string;
	className?: string;
}

export function AllIssuesIcon({
	color = "currentColor",
	className,
}: AllIssuesIconProps) {
	return <HiOutlineRectangleStack className={className} style={{ color }} />;
}
