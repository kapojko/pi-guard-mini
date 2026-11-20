/**
 * Archived-session regression replay for the thinking-guard detector.
 *
 * Fixtures (tests/fixtures/):
 *  - cases.json    — 24 entries extracted from the two incident archives:
 *                    the phantom-instruction session
 *                    (session-llama-swappy-2026-11-19.jsonl) and the
 *                    repeated-user session (session-pdf4llm-2026-10-22.jsonl),
 *                    each with the genuine user prompt that preceded it.
 *  - synthetic.json — hand-built cases for grounding suppression, role
 *                    markers, anchoring, and near-misses.
 *
 * Gates (TODO §5): must pass before hard stops are enabled for real use.
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectGuard, type GuardMatch } from "../extensions/guard-mini/detect.ts";

interface FixtureCase {
	name: string;
	source: string;
	expect: string | null;
	expectGrounded: boolean;
	genuinePrompt?: string;
	message: {
		role: string;
		content: Array<{ type: string; thinking?: string; text?: string }>;
	};
}

const here = dirname(fileURLToPath(import.meta.url));

function loadFixtures(file: string): FixtureCase[] {
	return JSON.parse(readFileSync(join(here, "fixtures", file), "utf8")) as FixtureCase[];
}

function assertCase(c: FixtureCase): void {
	const matches = detectGuard(c.message, c.genuinePrompt);
	if (c.expect === null) {
		// No detection at all — ordinary grounded/normal reasoning.
		assert.deepEqual(
			matches.map((m) => `${m.guardClass}:${m.rule}`),
			[],
			`${c.name} (${c.source}) must produce no match`,
		);
		return;
	}
	const relevant = matches.filter((m) => m.guardClass === c.expect);
	assert.ok(relevant.length > 0, `${c.name} (${c.source}) must match ${c.expect}, got: ${JSON.stringify(matches.map((m: GuardMatch) => m.guardClass))}`);
	const grounded = relevant.every((m) => m.grounded);
	assert.equal(
		grounded,
		c.expectGrounded,
		`${c.name} (${c.source}) grounded=${grounded}, expected ${c.expectGrounded}`,
	);
}

for (const c of loadFixtures("cases.json")) {
	test(`replay: ${c.name} [${c.source}]`, () => assertCase(c));
}

for (const c of loadFixtures("synthetic.json")) {
	test(`replay: ${c.name} [${c.source}]`, () => assertCase(c));
}

// ── corpus-level gates ──────────────────────────────────────────────────

test("replay: phantom session yields exactly the one known new-instruction", () => {
	const cases = loadFixtures("cases.json").filter((c) => c.source.startsWith("session-llama-swappy"));
	const hits = cases.filter((c) => {
		const matches = detectGuard(c.message, c.genuinePrompt);
		return matches.some((m) => !m.grounded);
	});
	assert.deepEqual(hits.map((c) => c.name), ["phantom-line96-new-request"]);
});

test("replay: exactly the six archived repeat examples match the repeat class", () => {
	const cases = loadFixtures("cases.json").filter((c) => c.source.startsWith("session-pdf4llm"));
	const hits = cases.filter((c) => {
		const matches = detectGuard(c.message, c.genuinePrompt);
		return matches.some((m) => m.guardClass === "repeat" && !m.grounded);
	});
	assert.equal(hits.length, 6);
});
