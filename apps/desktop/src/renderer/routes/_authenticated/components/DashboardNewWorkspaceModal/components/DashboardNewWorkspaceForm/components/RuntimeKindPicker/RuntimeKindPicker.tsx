import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { cn } from "@superset/ui/utils";
import {
	HiCheck,
	HiChevronUpDown,
	HiOutlineCloud,
	HiOutlineComputerDesktop,
} from "react-icons/hi2";
import type { WorkspaceRuntimeKind } from "renderer/stores/new-workspace-draft";
import { FormPickerTrigger } from "../../PromptGroup/components/FormPickerTrigger";

interface RuntimeKindPickerProps {
	runtimeKind: WorkspaceRuntimeKind;
	onSelectRuntimeKind: (runtimeKind: WorkspaceRuntimeKind) => void;
	className?: string;
}

const LABEL: Record<WorkspaceRuntimeKind, string> = {
	local: "Local",
	remote: "Remote",
};

function RuntimeKindIcon({
	runtimeKind,
}: {
	runtimeKind: WorkspaceRuntimeKind;
}) {
	return runtimeKind === "remote" ? (
		<HiOutlineCloud className="size-4 shrink-0" />
	) : (
		<HiOutlineComputerDesktop className="size-4 shrink-0" />
	);
}

export function RuntimeKindPicker({
	runtimeKind,
	onSelectRuntimeKind,
	className,
}: RuntimeKindPickerProps) {
	const selectedLabel = LABEL[runtimeKind];

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<FormPickerTrigger
					className={cn("max-w-[120px]", className)}
					aria-label={`Runtime: ${selectedLabel}`}
					title={`Runtime: ${selectedLabel}`}
				>
					<RuntimeKindIcon runtimeKind={runtimeKind} />
					<span className="truncate">{selectedLabel}</span>
					<HiChevronUpDown className="size-3 shrink-0" />
				</FormPickerTrigger>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-56">
				<DropdownMenuItem onSelect={() => onSelectRuntimeKind("local")}>
					<HiOutlineComputerDesktop className="size-4" />
					<span className="flex-1">Local machine</span>
					{runtimeKind === "local" && <HiCheck className="size-4" />}
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => onSelectRuntimeKind("remote")}>
					<HiOutlineCloud className="size-4" />
					<span className="flex-1">Remote sandbox</span>
					{runtimeKind === "remote" && <HiCheck className="size-4" />}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
