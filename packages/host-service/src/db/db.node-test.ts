// createDb runs under Node (`node --experimental-strip-types --test`) because it
// uses the native `better-sqlite3` binding, which Bun's test runner cannot load
// (oven-sh/bun#4290). The rest of the host-service suite that needs a DB uses
// `bun:sqlite` directly; this is the one test that exercises createDb itself,
// proving the Touchpoint-1 migration re-throw.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createDb } from "./db.ts";
import { terminalSessions } from "./schema.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../drizzle");

const tmpDirs: string[] = [];

function makeTmpDb(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-service-db-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "host.db");
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("createDb", () => {
	test("returns a working db with a valid migrations folder", () => {
		const db = createDb(makeTmpDb(), MIGRATIONS_FOLDER);
		const rows = db.select().from(terminalSessions).all();
		assert.ok(Array.isArray(rows));
	});

	test("throws when the migrations folder does not exist", () => {
		const garbage = path.join(
			path.dirname(makeTmpDb()),
			"no-such-migrations-folder",
		);
		assert.throws(() => createDb(makeTmpDb(), garbage));
	});
});
