/**
 * Unit tests for the thinking-guard detector (extensions/guard-mini/detect.ts).
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detectGuard, firstNonEmptyLine, normalize } from "../extensions/guard-mini/detect.ts";

function thinking(text: string) {
	return { role: "assistant", content: [{ type: "thinking", thinking: text }] };
}

// ── helpers ─────────────────────────────────────────────────────────────

test("firstNonEmptyLine skips blank lines and reports index", () => {
	assert.deepEqual(firstNonEmptyLine("\n\n  \nNew request: x\nrest"), { line: "New request: x", index: 3 });
	assert.equal(firstNonEmptyLine("   \n\t\n"), undefined);
	assert.deepEqual(firstNonEmptyLine("first"), { line: "first", index: 0 });
});

test("normalize collapses whitespace and lowercases", () => {
	assert.equal(normalize("  The   USER\n\nsaid\t\tyes. "), "the user said yes.");
});

// ── anchored rules: first non-empty line only ────────────────────────────

test("new-instruction: anchored 'New request:' first line", () => {
	const matches = detectGuard(thinking("New request: implement an endpoint with traversal protection.\n\nDesign notes."));
	assert.equal(matches.length, 1);
	assert.equal(matches[0]!.guardClass, "new-instruction");
	assert.equal(matches[0]!.rule, "new-instruction:first-line");
	assert.equal(matches[0]!.lineIndex, 0);
	assert.equal(matches[0]!.grounded, false);
});

test("new-instruction: synonyms another/next/task/instruction/feature", () => {
	for (const line of [
		"Another request: fix the build.",
		"Next task: add tests.",
		"Additional instruction: deploy now.",
		"New feature: add a cache layer.",
	]) {
		const matches = detectGuard(thinking(line + "\nreasoning"));
		assert.equal(matches[0]?.guardClass, "new-instruction", `line: ${line}`);
	}
});

test("new-instruction: colon is required", () => {
	assert.deepEqual(detectGuard(thinking("New request to implement something")), []);
});

test("new-instruction: not on the first non-empty line", () => {
	assert.deepEqual(detectGuard(thinking("Let me continue.\n\nNew request: implement X.")), []);
});

test("repeat: the six archived phrasings", () => {
	for (const line of [
		"The user repeated the same request — probably prompting me to continue.",
		"The user keeps repeating the same request.",
		"The user is repeating the request — I should wrap this up.",
		"The user is repeating the same request. I need to finish this properly.",
		"The user repeated the request — continuing.",
		"The user repeated the request — they want completion.",
	]) {
		const matches = detectGuard(thinking(line + "\nmore"));
		assert.equal(matches[0]?.guardClass, "repeat", `line: ${line}`);
		assert.equal(matches[0]!.grounded, false, `line: ${line}`);
	}
});

test("repeat: resent/resending variants (pi issue #10097 phrasings)", () => {
	for (const line of [
		"The user resent the same message.",
		"The user keeps resending the same message — they want me to keep going.",
		"The user has resent the same message multiple times.",
		"The user repeats the request.",
	]) {
		assert.equal(detectGuard(thinking(line))[0]?.guardClass, "repeat", `line: ${line}`);
	}
});

test("repeat: near-miss 'The user is asking' does not match", () => {
	assert.deepEqual(detectGuard(thinking("The user is asking why I wrote that. Let me explain.")), []);
});

test("repeat: grounded when the whole line is quoted in the prompt", () => {
	const line = "The user repeated the same request — probably prompting me to continue.";
	const matches = detectGuard(thinking(line), `Look at this line: "${line}" and explain it.`);
	assert.equal(matches[0]!.guardClass, "repeat");
	assert.equal(matches[0]!.grounded, true);
});

test("reversal: undo/rollback/revert/reset/cancel/abort claims", () => {
	for (const line of [
		"The user asked me to undo the last commit.",
		"The user wants to revert the release.",
		"The user wants me to reset the branch.",
		"The user said to cancel the deploy.",
		"The user asked me to abort the migration.",
		"The user wants to roll back the changes.",
	]) {
		assert.equal(detectGuard(thinking(line))[0]?.guardClass, "reversal", `line: ${line}`);
	}
});

test("reversal: 'not to commit' claims", () => {
	for (const line of [
		"The user said not to commit anything yet.",
		"The user told me do not commit the change.",
	]) {
		assert.equal(detectGuard(thinking(line))[0]?.guardClass, "reversal", `line: ${line}`);
	}
});

test("reversal: near-misses must not match", () => {
	for (const line of [
		"The user asked me to commit and push the changes.",   // genuine commit request restated
		"The user asked a question; the change is a doc fix.",
		"The user wants me to create a directory for the report.",
		"The user wants me to review the last commit I made.",
		"The user wants me to carefully document this incident.",
	]) {
		assert.deepEqual(detectGuard(thinking(line + " More context.")), [], `line: ${line}`);
	}
});

test("reversal: grounded by reversal keyword in the prompt", () => {
	const matches = detectGuard(thinking("The user wants me to revert the last commit."), "Please revert the last commit.");
	assert.equal(matches[0]!.guardClass, "reversal");
	assert.equal(matches[0]!.grounded, true);
});

test("fabricated-approval: said yes / approved / confirmed / agreed", () => {
	for (const line of [
		"The user said yes, proceed with the push.",
		"The user says go ahead.",
		"The user approved the deploy.",
		"The user confirmed the migration.",
		"The user agreed to the plan.",
		"The user authorized the release.",
	]) {
		assert.equal(detectGuard(thinking(line))[0]?.guardClass, "fabricated-approval", `line: ${line}`);
	}
});

test("fabricated-approval: grounded when the prompt carries approval vocabulary", () => {
	const m = detectGuard(thinking("The user said yes, proceed with the push."), "Yes, go ahead and push.");
	assert.equal(m[0]!.guardClass, "fabricated-approval");
	assert.equal(m[0]!.grounded, true);
});

test("fabricated-approval: 'The user says continue' is not an approval claim", () => {
	assert.deepEqual(detectGuard(thinking('The user says "continue". Already done.')), []);
});

test("priority: reversal before approval; approval before repeat", () => {
	assert.equal(detectGuard(thinking("The user said yes to revert it."))[0]?.guardClass, "fabricated-approval");
});

// ── role-marker rules: whole first thinking block ────────────────────────

test("role-marker: bare 'user' line anywhere in the block", () => {
	const matches = detectGuard(thinking("Now I will proceed.\nuser\nwith the next step"));
	assert.equal(matches.length, 1);
	assert.equal(matches[0]!.guardClass, "role-marker");
	assert.equal(matches[0]!.rule, "role-marker:bare-user-line");
	assert.equal(matches[0]!.lineIndex, 1);
});

test("role-marker: ChatML <|im_start|>user marker", () => {
	const matches = detectGuard(thinking("Conversation:\n<|im_start|>user\ndo the thing\n<|im_end|>"));
	assert.equal(matches.length, 1);
	assert.equal(matches[0]!.guardClass, "role-marker");
	assert.equal(matches[0]!.rule, "role-marker:chatml-user");
});

test("role-marker: 'user' inside prose is not a bare line", () => {
	assert.deepEqual(detectGuard(thinking("The user table needs fixing.\nLet me check the schema.")), []);
});

test("role-marker: ChatML marker grounded when the prompt quotes it", () => {
	const m = detectGuard(
		thinking("Conversation:\n<|im_start|>user\nhello"),
		"Check where <|im_start|>user appears in the render.",
	);
	assert.equal(m[0]!.guardClass, "role-marker");
	assert.equal(m[0]!.grounded, true);
});

test("role-marker: bare 'user' word in ordinary prose does not ground", () => {
	const m = detectGuard(thinking("Proceed.\nuser\nnext"), "Fix the user table migration.");
	assert.equal(m[0]!.grounded, false);
});

test("role-marker: standalone 'user' line in the prompt grounds", () => {
	const m = detectGuard(thinking("Proceed.\nuser\nnext"), "Why is there a bare line\nuser\nin the transcript?");
	assert.equal(m[0]!.grounded, true);
});

// ── structure ───────────────────────────────────────────────────────────

test("no thinking block and empty thinking produce no matches", () => {
	assert.deepEqual(detectGuard({ role: "assistant", content: [{ type: "text", text: "done" }] }), []);
	assert.deepEqual(detectGuard(thinking("  \n \n")), []);
});

test("only the first thinking block is scanned", () => {
	const message = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "First block is clean." },
			{ type: "thinking", thinking: "New request: implement something else." },
		],
	};
	assert.deepEqual(detectGuard(message), []);
});

test("excerpt is truncated to 200 characters", () => {
	const long = "New request: " + "x".repeat(500);
	const m = detectGuard(thinking(long))[0]!;
	assert.equal(m.excerpt.length, 200);
	assert.ok(m.excerpt.endsWith("…"));
});

test("anchored rules apply after leading blank lines", () => {
	const m = detectGuard(thinking("\n\n\nNew request: do it.\n"));
	assert.equal(m[0]!.guardClass, "new-instruction");
	assert.equal(m[0]!.lineIndex, 3);
});
