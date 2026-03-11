import Image from "next/image";
import { env } from "@/env";

export default async function ConsentPage() {
	return (
		<div className="relative flex min-h-screen flex-col">
			<header className="container mx-auto px-6 py-6">
				<a href={env.NEXT_PUBLIC_MARKETING_URL}>
					<Image
						src="/title.svg"
						alt="Superset"
						width={140}
						height={24}
						priority
					/>
				</a>
			</header>
			<main className="flex flex-1 items-center justify-center">
				<div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[400px]">
					<div className="flex flex-col space-y-2 text-center">
						<h1 className="text-2xl font-semibold tracking-tight">
							Not Available
						</h1>
						<p className="text-muted-foreground text-sm">
							OAuth consent is not available in this version.
						</p>
					</div>
				</div>
			</main>
		</div>
	);
}
