import { Button } from "@superset/ui/button";
import { Users } from "lucide-react";
import Link from "next/link";

export default async function AcceptInvitationPage() {
	return (
		<div className="flex min-h-screen items-center justify-center p-4">
			<div className="max-w-lg space-y-6 text-center">
				<div className="mx-auto flex h-16 w-16 items-center justify-center rounded-xl border border-border">
					<Users className="h-8 w-8 text-muted-foreground" />
				</div>
				<div className="space-y-4">
					<h1 className="text-2xl font-semibold">Not Available</h1>
					<p className="text-muted-foreground">
						Team invitations are not available in this version.
					</p>
				</div>
				<Button asChild variant="outline">
					<Link href="/">Return to dashboard</Link>
				</Button>
			</div>
		</div>
	);
}
