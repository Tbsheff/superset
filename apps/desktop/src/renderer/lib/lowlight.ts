import type { Lowlight } from "lowlight";

let _lowlight: Lowlight | null = null;

export function getLowlight(): Lowlight {
	if (!_lowlight) {
		const { createLowlight } = require("lowlight") as typeof import("lowlight");
		const bash = require("highlight.js/lib/languages/bash").default;
		const css = require("highlight.js/lib/languages/css").default;
		const javascript = require("highlight.js/lib/languages/javascript").default;
		const json = require("highlight.js/lib/languages/json").default;
		const markdown = require("highlight.js/lib/languages/markdown").default;
		const python = require("highlight.js/lib/languages/python").default;
		const sql = require("highlight.js/lib/languages/sql").default;
		const typescript = require("highlight.js/lib/languages/typescript").default;
		const xml = require("highlight.js/lib/languages/xml").default;
		const yaml = require("highlight.js/lib/languages/yaml").default;

		_lowlight = createLowlight();
		_lowlight.register({
			bash,
			css,
			javascript,
			json,
			markdown,
			python,
			sql,
			typescript,
			xml,
			yaml,
		});
	}
	return _lowlight;
}
