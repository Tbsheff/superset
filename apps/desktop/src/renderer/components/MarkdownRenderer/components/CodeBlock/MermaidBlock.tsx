import { mermaid } from "@streamdown/mermaid";
import { Streamdown } from "streamdown";

const mermaidPlugins = { mermaid };

interface MermaidBlockProps {
	code: string;
	isDark: boolean;
}

export function MermaidBlock({ code, isDark }: MermaidBlockProps) {
	return (
		<Streamdown
			mode="static"
			plugins={mermaidPlugins}
			mermaid={{ config: { theme: isDark ? "dark" : "default" } }}
		>
			{`\`\`\`mermaid\n${code}\n\`\`\``}
		</Streamdown>
	);
}
