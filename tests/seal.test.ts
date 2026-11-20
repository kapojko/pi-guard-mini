/**
 * Unit tests for the git seal (extensions/guard-mini/seal.ts).
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	classifyCommand,
	classifySegment,
	evaluateShellCommand,
	isFileMutationTool,
	splitCommandSegments,
	tokenize,
	type SealState,
} from "../extensions/guard-mini/seal.ts";

// ── splitting / tokenizing ───────────────────────────────────────────────

test("splitCommandSegments: separators", () => {
	assert.deepEqual(splitCommandSegments("git status; git log"), ["git status", "git log"]);
	assert.deepEqual(splitCommandSegments("git add . && git commit -m x || echo fail"), [
		"git add .",
		"git commit -m x",
		"echo fail",
	]);
	assert.deepEqual(splitCommandSegments("git log | Select-String fix"), ["git log", "Select-String fix"]);
	assert.deepEqual(splitCommandSegments("line1\nline2"), ["line1", "line2"]);
});

test("splitCommandSegments: quoted compound separators stay inside the segment", () => {
	assert.deepEqual(splitCommandSegments('git commit -m "a; b && c" && git push'), [
		'git commit -m "a; b && c"',
		"git push",
	]);
	assert.deepEqual(splitCommandSegments("git commit -m 'a; b' ; git push"), [
		"git commit -m 'a; b'",
		"git push",
	]);
});

test("splitCommandSegments: empty segments dropped", () => {
	assert.deepEqual(splitCommandSegments("  ; ;\n git status "), ["git status"]);
	assert.deepEqual(splitCommandSegments(""), []);
});

test("tokenize: respects quotes", () => {
	assert.deepEqual(tokenize('git -C "path with space" push'), ["git", "-C", "path with space", "push"]);
	assert.deepEqual(tokenize("git commit -m 'two words'"), ["git", "commit", "-m", "two words"]);
});

// ── segment classification ───────────────────────────────────────────────

test("classifySegment: recognized verbs", () => {
	assert.equal(classifySegment("git commit -m x").verb, "commit");
	assert.equal(classifySegment("git commit --amend --no-edit").verb, "commit");
	assert.equal(classifySegment("git push origin main").verb, "push");
	assert.equal(classifySegment("git push --tags").verb, "push");
	assert.equal(classifySegment("git.exe status").verb, "read-only-git");
	assert.equal(classifySegment("& git status --short").verb, "read-only-git"); // PowerShell call operator
	assert.equal(classifySegment("git -C ../other push").verb, "push"); // global option with value
	assert.equal(classifySegment("git -c user.name=x commit").verb, "commit");
	assert.equal(classifySegment("git --no-pager log -5").verb, "read-only-git");
});

test("classifySegment: read-only subcommands with argument constraints", () => {
	assert.equal(classifySegment("git branch").verb, "read-only-git");
	assert.equal(classifySegment("git branch -a").verb, "read-only-git");
	assert.equal(classifySegment("git branch -vv").verb, "read-only-git");
	assert.equal(classifySegment("git branch feature-x").verb, "mutating-git");
	assert.equal(classifySegment("git branch -D feature-x").verb, "mutating-git");
	assert.equal(classifySegment("git tag").verb, "read-only-git");
	assert.equal(classifySegment('git tag -l "v*"').verb, "read-only-git");
	assert.equal(classifySegment("git tag v1.0").verb, "mutating-git");
	assert.equal(classifySegment("git remote").verb, "read-only-git");
	assert.equal(classifySegment("git remote -v").verb, "read-only-git");
	assert.equal(classifySegment("git remote add origin x").verb, "mutating-git");
	assert.equal(classifySegment("git config --get user.name").verb, "read-only-git");
	assert.equal(classifySegment("git config user.name X").verb, "mutating-git");
	assert.equal(classifySegment("git stash").verb, "mutating-git");
	assert.equal(classifySegment("git stash list").verb, "read-only-git");
	assert.equal(classifySegment("git worktree list").verb, "read-only-git");
	assert.equal(classifySegment("git worktree add ../x").verb, "mutating-git");
	assert.equal(classifySegment("git status --short").verb, "read-only-git");
	assert.equal(classifySegment("git diff HEAD~1").verb, "read-only-git");
	assert.equal(classifySegment("git show e1b90fe").verb, "read-only-git");
});

test("classifySegment: unknown git subcommands fail closed", () => {
	assert.equal(classifySegment("git config --unset x").verb, "mutating-git");
	assert.equal(classifySegment("git frobnicate").verb, "mutating-git");
	assert.equal(classifySegment("git").verb, "mutating-git"); // no subcommand
});

test("classifySegment: non-git commands pass", () => {
	assert.equal(classifySegment("npm install").verb, "non-git");
	assert.equal(classifySegment("Get-ChildItem -Recurse").verb, "non-git");
	assert.equal(classifySegment("gitk --all").verb, "non-git"); // different binary
	assert.equal(classifySegment("echo git commit").verb, "non-git"); // git not the command
});

test("classifyCommand: compound counting", () => {
	const c = classifyCommand("git status --short; git log --oneline -3");
	assert.equal(c.readonlyGitCount, 2);
	assert.equal(c.commitCount, 0);
	assert.equal(c.pushCount, 0);

	const incident = classifyCommand(
		'git add README.md; git status --short; git commit -m "[1.13] Document config backup"; git push origin main',
	);
	assert.equal(incident.commitCount, 1);
	assert.equal(incident.pushCount, 1);
	assert.equal(incident.mutatingGitCount, 1); // git add
	assert.equal(incident.readonlyGitCount, 1);
});

test("classifyCommand: quoted separator inside -m message stays one segment", () => {
	const c = classifyCommand('git commit -m "part one; part two | and more"');
	assert.equal(c.segments.length, 1);
	assert.equal(c.commitCount, 1);
});

test("classifyCommand: redirection makes a segment mutating", () => {
	assert.equal(classifyCommand("git log > out.txt").mutatingGitCount, 1);
	assert.equal(classifyCommand("git log >> out.txt").mutatingGitCount, 1);
	assert.equal(classifyCommand('git log 2> err.txt').mutatingGitCount, 1);
	// fd duplication is not a file write
	assert.equal(classifyCommand("git push origin main 2>&1").pushCount, 1);
	assert.equal(classifyCommand("git push origin main 2>&1").mutatingGitCount, 0);
	assert.equal(classifyCommand("git log 2>&1").mutatingGitCount, 0);
	// quoted > is not a redirection
	assert.equal(classifyCommand('git log -S "> out"').readonlyGitCount, 1);
	assert.equal(classifyCommand('git log -S "> out"').mutatingGitCount, 0);
});

// ── decision table ───────────────────────────────────────────────────────

test("evaluateShellCommand: unsealed allows everything", () => {
	assert.equal(evaluateShellCommand("unsealed", "git commit -m x").action, "allow");
	assert.equal(evaluateShellCommand("unsealed", "git push").action, "allow");
	assert.equal(evaluateShellCommand("unsealed", "rm -rf /").action, "allow"); // seal scope is git only
});

test("evaluateShellCommand: awaiting-push allows one push, blocks other mutations", () => {
	const s: SealState = "awaiting-push";
	assert.equal(evaluateShellCommand(s, "git push").action, "allow-push-once");
	assert.equal(evaluateShellCommand(s, "git push origin main 2>&1").action, "allow-push-once");
	assert.equal(evaluateShellCommand(s, "git status && git push origin main").action, "allow-push-once");
	assert.equal(evaluateShellCommand(s, "git push; git push").action, "block"); // two pushes
	assert.equal(evaluateShellCommand(s, "git push && git commit -m x").action, "block"); // push + mutation
	assert.equal(evaluateShellCommand(s, "git push && git add .").action, "block");
	assert.equal(evaluateShellCommand(s, "git commit -m x").action, "block");
	assert.equal(evaluateShellCommand(s, "git reset --hard").action, "block");
	assert.equal(evaluateShellCommand(s, "git branch -D feat").action, "block");
	assert.equal(evaluateShellCommand(s, "git status --short").action, "allow");
	assert.equal(evaluateShellCommand(s, "git log --oneline").action, "allow");
	assert.equal(evaluateShellCommand(s, "git diff").action, "allow");
	assert.equal(evaluateShellCommand(s, "npm install").action, "allow"); // non-git coverage limit
	assert.equal(evaluateShellCommand(s, "git log > out.txt").action, "block"); // redirect writes a file
});

test("evaluateShellCommand: pushed blocks every mutation, allows read-only", () => {
	const s: SealState = "pushed";
	assert.equal(evaluateShellCommand(s, "git push").action, "block");
	assert.equal(evaluateShellCommand(s, "git commit -m x").action, "block");
	assert.equal(evaluateShellCommand(s, "git merge feature").action, "block");
	assert.equal(evaluateShellCommand(s, "git status").action, "allow");
	assert.equal(evaluateShellCommand(s, "git show HEAD").action, "allow");
});

test("isFileMutationTool", () => {
	assert.equal(isFileMutationTool("edit"), true);
	assert.equal(isFileMutationTool("write"), true);
	assert.equal(isFileMutationTool("read"), false);
	assert.equal(isFileMutationTool("powershell"), false);
});
