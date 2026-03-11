"use client";

import { authClient } from "@superset/auth/client";
import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FaGithub } from "react-icons/fa";
import { env } from "@/env";

export default function SignUpPage() {
	const router = useRouter();
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [isLoadingGithub, setIsLoadingGithub] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const signUpWithEmail = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsLoading(true);
		setError(null);

		try {
			const result = await authClient.signUp.email({
				email,
				password,
				name: name || email.split("@")[0] || "User",
			});
			if (result.error) {
				setError(result.error.message ?? "Sign up failed");
				setIsLoading(false);
				return;
			}
			router.push("/");
		} catch (err) {
			console.error("Sign up failed:", err);
			setError("Failed to sign up. Please try again.");
			setIsLoading(false);
		}
	};

	const signUpWithGithub = async () => {
		setIsLoadingGithub(true);
		setError(null);

		try {
			await authClient.signIn.social({
				provider: "github",
				callbackURL: env.NEXT_PUBLIC_WEB_URL,
			});
		} catch (err) {
			console.error("Sign up failed:", err);
			setError("Failed to sign up. Please try again.");
			setIsLoadingGithub(false);
		}
	};

	const isDisabled = isLoading || isLoadingGithub;

	return (
		<div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
			<div className="flex flex-col space-y-2 text-center">
				<h1 className="text-2xl font-semibold tracking-tight">
					Create an account
				</h1>
				<p className="text-muted-foreground text-sm">
					Sign up to get started with Superset
				</p>
			</div>
			<div className="grid gap-4">
				{error && (
					<p className="text-destructive text-center text-sm">{error}</p>
				)}
				<form onSubmit={signUpWithEmail} className="grid gap-3">
					<div className="space-y-1.5">
						<Label htmlFor="name">Name</Label>
						<Input
							id="name"
							type="text"
							placeholder="Your name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							disabled={isDisabled}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="email">Email</Label>
						<Input
							id="email"
							type="email"
							placeholder="you@example.com"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
							disabled={isDisabled}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="password">Password</Label>
						<Input
							id="password"
							type="password"
							placeholder="••••••••"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
							minLength={8}
							disabled={isDisabled}
						/>
					</div>
					<Button type="submit" disabled={isDisabled} className="w-full">
						{isLoading ? "Loading..." : "Create account"}
					</Button>
				</form>

				<div className="relative">
					<div className="absolute inset-0 flex items-center">
						<div className="w-full border-t" />
					</div>
					<div className="relative flex justify-center text-xs uppercase">
						<span className="bg-background px-2 text-muted-foreground">or</span>
					</div>
				</div>

				<Button
					variant="outline"
					disabled={isDisabled}
					onClick={signUpWithGithub}
					className="w-full"
				>
					<FaGithub className="mr-2 size-4" />
					{isLoadingGithub ? "Loading..." : "Sign up with GitHub"}
				</Button>
				<p className="text-muted-foreground px-8 text-center text-sm">
					By clicking continue, you agree to our{" "}
					<a
						href={`${env.NEXT_PUBLIC_MARKETING_URL}/terms`}
						target="_blank"
						rel="noopener noreferrer"
						className="hover:text-primary underline underline-offset-4"
					>
						Terms of Service
					</a>{" "}
					and{" "}
					<a
						href={`${env.NEXT_PUBLIC_MARKETING_URL}/privacy`}
						target="_blank"
						rel="noopener noreferrer"
						className="hover:text-primary underline underline-offset-4"
					>
						Privacy Policy
					</a>
					.
				</p>
				<p className="text-center text-sm">
					Already have an account?{" "}
					<Link
						href="/sign-in"
						className="hover:text-primary underline underline-offset-4"
					>
						Sign in
					</Link>
				</p>
			</div>
		</div>
	);
}
