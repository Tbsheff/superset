import type { ExternalApp } from "@superset/local-db";
import { TabsContent } from "./TabsContent";
import { GroupStrip } from "./TabsContent/GroupStrip";

interface ContentViewProps {
	defaultExternalApp?: ExternalApp | null;
	onOpenInApp: () => void;
	onOpenQuickOpen: () => void;
}

export function ContentView({
	defaultExternalApp,
	onOpenInApp,
	onOpenQuickOpen,
}: ContentViewProps) {
	return (
		<div className="h-full flex flex-col overflow-hidden">
			<div className="flex items-stretch bg-background shrink-0 border-b border-border/40">
				<GroupStrip />
			</div>
			<TabsContent
				defaultExternalApp={defaultExternalApp}
				onOpenInApp={onOpenInApp}
				onOpenQuickOpen={onOpenQuickOpen}
			/>
		</div>
	);
}
