import { Button } from "@superset/ui/button";
import { Card } from "@superset/ui/card";
import { WifiOff } from "lucide-react";

interface ConnectionErrorOverlayProps {
	onRetry: () => void;
}

export function ConnectionErrorOverlay({
	onRetry,
}: ConnectionErrorOverlayProps) {
	return (
		<div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50">
			<Card className="gap-3 py-4 px-2">
				<div className="flex flex-col items-center text-center gap-1.5 px-4">
					<WifiOff className="size-5 text-muted-foreground" />
					<div className="space-y-0.5">
						<p className="text-sm font-medium">Connection error</p>
						<p className="text-xs text-muted-foreground">
							Failed to connect to terminal
						</p>
					</div>
				</div>
				<div className="px-4">
					<Button size="sm" className="w-full" onClick={onRetry}>
						Retry
					</Button>
				</div>
			</Card>
		</div>
	);
}
