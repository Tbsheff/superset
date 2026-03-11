"use client";

import { authClient } from "@superset/auth/client";
import { Avatar, AvatarFallback } from "@superset/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { ChevronDown, LogOut } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function Header() {
	const { data: session } = authClient.useSession();
	const router = useRouter();

	const user = session?.user;
	const displayName = "Superset";

	const handleSignOut = async () => {
		await authClient.signOut();
		router.push("/sign-in");
	};

	return (
		<header className="sticky left-0 top-0 z-40 w-full border-b border-border/50 bg-background py-4">
			<div className="mx-auto flex min-h-8 w-[95vw] max-w-screen-2xl items-center justify-between">
				<Link href="/" aria-label="Go to home">
					<Image
						src="/title.svg"
						alt="Superset"
						width={150}
						height={25}
						priority
					/>
				</Link>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 bg-secondary/50 px-3 py-1.5 transition-all duration-150 hover:border-border hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							aria-label="User menu"
						>
							<Avatar className="size-5">
								<AvatarFallback className="text-[10px]">
									{displayName.charAt(0)}
								</AvatarFallback>
							</Avatar>
							<span className="max-w-32 truncate text-sm font-medium">
								{displayName}
							</span>
							<ChevronDown className="size-4 text-muted-foreground" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-56">
						<DropdownMenuLabel>
							<div className="flex flex-col space-y-1">
								<p className="text-sm font-medium">{user?.name}</p>
								<p className="text-xs text-muted-foreground">{user?.email}</p>
							</div>
						</DropdownMenuLabel>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							className="cursor-pointer gap-2"
							onClick={handleSignOut}
						>
							<LogOut className="size-4" />
							<span>Log out</span>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</header>
	);
}
