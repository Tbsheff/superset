import { CircleUser } from "lucide-react";

interface AssigneeMenuIconProps {
	color?: string;
	className?: string;
}

export function AssigneeMenuIcon({
	color = "currentColor",
	className,
}: AssigneeMenuIconProps) {
	return <CircleUser className={className} style={{ color }} />;
}
