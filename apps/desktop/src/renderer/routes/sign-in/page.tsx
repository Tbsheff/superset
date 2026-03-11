import { COMPANY } from "@superset/shared/constants";
import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { Spinner } from "@superset/ui/spinner";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { FaGithub } from "react-icons/fa";
import { env } from "renderer/env.renderer";
import { track } from "renderer/lib/analytics";
import { authClient } from "renderer/lib/auth-client";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { SupersetLogo } from "./components/SupersetLogo";
import { useSessionRecovery } from "./hooks/useSessionRecovery";

export const Route = createFileRoute("/sign-in/")({
	component: SignInPage,
});

function SignInPage() {
	const signInMutation = electronTrpc.auth.signIn.useMutation();
	const { hasLocalToken, isPending, session } = useSessionRecovery();
	const navigate = useNavigate();

	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [name, setName] = useState("");
	const [isSignUp, setIsSignUp] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Dev bypass: skip sign-in entirely
	if (env.SKIP_ENV_VALIDATION) {
		return <Navigate to="/workspace" replace />;
	}

	if (isPending) {
		return (
			<div className="flex h-screen w-screen items-center justify-center bg-background">
				<Spinner className="size-8" />
			</div>
		);
	}

	if (session?.user) {
		return <Navigate to="/workspace" replace />;
	}

	const handleEmailAuth = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsLoading(true);
		setError(null);

		try {
			if (isSignUp) {
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
			} else {
				const result = await authClient.signIn.email({
					email,
					password,
				});
				if (result.error) {
					setError(result.error.message ?? "Sign in failed");
					setIsLoading(false);
					return;
				}
			}
			track("auth_started", { provider: "email" });
			navigate({ to: "/workspace", replace: true });
		} catch (err) {
			setError(err instanceof Error ? err.message : "Authentication failed");
			setIsLoading(false);
		}
	};

	const signInWithGithub = () => {
		track("auth_started", { provider: "github" });
		signInMutation.mutate({ provider: "github" });
	};

	const isSubmitting = isLoading || signInMutation.isPending;

	return (
		<div className="flex flex-col h-full w-full bg-background">
			<div className="h-12 w-full drag shrink-0" />

			<div className="flex flex-1 items-center justify-center">
				<div className="flex flex-col items-center w-full max-w-md px-8">
					<div className="mb-8">
						<SupersetLogo className="h-12 w-auto" />
					</div>

					<div className="text-center mb-8">
						<h1 className="text-xl font-semibold text-foreground mb-2">
							Welcome to Superset
						</h1>
						<p className="text-sm text-muted-foreground">
							{hasLocalToken
								? "Restoring your session"
								: isSignUp
									? "Create an account to get started"
									: "Sign in to get started"}
						</p>
					</div>

					<form
						onSubmit={handleEmailAuth}
						className="flex flex-col gap-3 w-full max-w-xs"
					>
						{isSignUp && (
							<div className="space-y-1.5">
								<Label htmlFor="name">Name</Label>
								<Input
									id="name"
									type="text"
									placeholder="Your name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									disabled={isSubmitting}
								/>
							</div>
						)}
						<div className="space-y-1.5">
							<Label htmlFor="email">Email</Label>
							<Input
								id="email"
								type="email"
								placeholder="you@example.com"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								required
								disabled={isSubmitting}
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
								disabled={isSubmitting}
							/>
						</div>

						{error && (
							<p className="text-sm text-destructive text-center">{error}</p>
						)}

						<Button type="submit" size="lg" disabled={isSubmitting}>
							{isSubmitting
								? "Loading..."
								: isSignUp
									? "Create account"
									: "Sign in"}
						</Button>

						<button
							type="button"
							onClick={() => {
								setIsSignUp(!isSignUp);
								setError(null);
							}}
							className="text-xs text-muted-foreground hover:text-foreground transition-colors"
						>
							{isSignUp
								? "Already have an account? Sign in"
								: "Don't have an account? Sign up"}
						</button>

						<div className="relative my-2">
							<div className="absolute inset-0 flex items-center">
								<div className="w-full border-t" />
							</div>
							<div className="relative flex justify-center text-xs uppercase">
								<span className="bg-background px-2 text-muted-foreground">
									or
								</span>
							</div>
						</div>

						<Button
							type="button"
							variant="outline"
							size="lg"
							onClick={signInWithGithub}
							className="w-full gap-3"
							disabled={isSubmitting}
						>
							<FaGithub className="size-5" />
							Continue with GitHub
						</Button>
					</form>

					<p className="mt-8 text-xs text-muted-foreground/70 text-center max-w-xs">
						By signing in, you agree to our{" "}
						<a
							href={COMPANY.TERMS_URL}
							target="_blank"
							rel="noopener noreferrer"
							className="underline hover:text-muted-foreground transition-colors"
						>
							Terms of Service
						</a>{" "}
						and{" "}
						<a
							href={COMPANY.PRIVACY_URL}
							target="_blank"
							rel="noopener noreferrer"
							className="underline hover:text-muted-foreground transition-colors"
						>
							Privacy Policy
						</a>
					</p>
				</div>
			</div>
		</div>
	);
}
