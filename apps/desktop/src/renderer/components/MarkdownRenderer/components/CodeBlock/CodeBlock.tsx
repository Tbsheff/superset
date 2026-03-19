import "./code-highlight.css";

import { toHtml } from "hast-util-to-html";
import { lazy, type ReactNode, Suspense, useMemo } from "react";
import { getLowlight } from "renderer/lib/lowlight";
import { useTheme } from "renderer/stores";

const MermaidBlock = lazy(() =>
	import("./MermaidBlock").then((m) => ({ default: m.MermaidBlock })),
);

interface CodeNode {
	position?: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
}

interface CodeBlockProps {
	children?: ReactNode;
	className?: string;
	node?: CodeNode;
}

export function CodeBlock({ children, className, node }: CodeBlockProps) {
	const theme = useTheme();
	const isDark = theme?.type !== "light";

	const match = /language-(\w+)/.exec(className || "");
	const language = match ? match[1] : undefined;
	const codeString = String(children).replace(/\n$/, "");

	const isInline =
		!language && node?.position?.start.line === node?.position?.end.line;

	if (isInline) {
		return (
			<code className="px-1.5 py-0.5 rounded bg-muted font-mono text-sm">
				{children}
			</code>
		);
	}

	if (language === "mermaid") {
		return (
			<Suspense
				fallback={
					<pre className="rounded-md text-sm p-4 bg-muted overflow-x-auto">
						<code>{codeString}</code>
					</pre>
				}
			>
				<MermaidBlock code={codeString} isDark={isDark} />
			</Suspense>
		);
	}

	return (
		<HighlightedCode code={codeString} language={language} isDark={isDark} />
	);
}

function HighlightedCode({
	code,
	language,
	isDark,
}: {
	code: string;
	language: string | undefined;
	isDark: boolean;
}) {
	const html = useMemo(() => {
		try {
			const ll = getLowlight();
			const tree = language
				? ll.highlight(language, code)
				: ll.highlightAuto(code);
			return toHtml(tree);
		} catch {
			// Language not registered — fall back to unhighlighted
			const tree = getLowlight().highlightAuto(code);
			return toHtml(tree);
		}
	}, [code, language]);

	return (
		<div
			className={`rounded-md text-sm overflow-x-auto ${isDark ? "hljs-dark" : "hljs-light"}`}
		>
			<pre className="p-4 m-0">
				<code
					className="hljs"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: lowlight produces safe HTML from code tokens
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			</pre>
		</div>
	);
}
