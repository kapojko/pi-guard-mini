/**
 * guard-mini — git commit/push seal. Pure functions, no pi imports.
 *
 * Deliberately narrow command recognition (see TODO: "do not try to
 * reproduce a shell interpreter"):
 *
 *  - A command is split into segments on `;`, `&&`, `||`, `|`, `&`, and
 *    newlines, respecting single/double quotes (so `git commit -m "a; b"`
 *    stays one segment).
 *  - A segment is a git invocation when it starts with `git`/`git.exe`
 *    (after global options such as `-C <path>` / `-c k=v` / `--no-pager`).
 *  - Git subcommands: a small read-only allowlist is permitted while
 *    sealed; `commit` and `push` are recognized verbs; every other git
 *    subcommand (including unknown ones) counts as mutating — fail-closed
 *    for git specifically, since the seal is a git-boundary guard.
 *  - An unquoted `>` / `>>` redirection (except fd-duplication forms like
 *    `2>&1`) makes the segment mutating. Everything else non-git passes:
 *    unknown non-git verbs (`npm`, `Set-Content`, …) are a documented
 *    coverage limit, not a permission system.
 *
 * State machine:
 *
 *   unsealed --successful recognized git commit--> awaiting-push
 *            --one successful recognized git push--> pushed
 *
 * Transitions happen in the caller (index.ts) on successful tool results;
 * this module only classifies and decides.
 */

export type SealState = "unsealed" | "awaiting-push" | "pushed";

export type SegmentVerb =
	| "commit"
	| "push"
	| "read-only-git"
	| "mutating-git"
	| "non-git";

export interface SegmentClassification {
	segment: string;
	verb: SegmentVerb;
	/** Git subcommand for git segments (e.g. "push", "status"); undefined for non-git. */
	subcommand?: string;
}

export interface CommandClassification {
	segments: SegmentClassification[];
	commitCount: number;
	pushCount: number;
	mutatingGitCount: number;
	readonlyGitCount: number;
	nonGitCount: number;
	commitPending: boolean;
	pushPending: boolean;
}

export interface SealDecision {
	action: "allow" | "block" | "allow-push-once";
	/** Explanation for the incident log. */
	detail: string;
}

// ── Tokenizing / splitting ───────────────────────────────────────────────

/** Split a shell command into sequence/pipeline segments, respecting quotes. */
export function splitCommandSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	const flush = () => {
		const trimmed = current.trim();
		if (trimmed) segments.push(trimmed);
		current = "";
	};
	let i = 0;
	while (i < command.length) {
		const ch = command[i]!;
		if (quote) {
			if (ch === quote) quote = null;
			current += ch;
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			i++;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "\n") {
			flush();
			i++;
			continue;
		}
		if (ch === "&") {
			if (command.slice(i, i + 2) === "&&") {
				flush();
			i += 2;
			continue;
			}
			// `>&1` fd duplication: the '&' belongs to the current token.
			if (current.endsWith(">") && /\d/.test(command[i + 1] ?? "")) {
				current += ch;
				i++;
				continue;
			}
			flush(); // background / call operator boundary
			i++;
			continue;
		}
		current += ch;
		i++;
	}
	flush();
	return segments;
}

/** Whitespace tokenizer respecting single/double quotes. */
export function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	const flush = () => {
		if (current) tokens.push(current);
		current = "";
	};
	for (const ch of segment) {
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			continue;
		}
		current += ch;
	}
	flush();
	return tokens;
}

// ── Git classification ───────────────────────────────────────────────────

/** Git subcommands that are unconditionally read-only. */
const READONLY_SUBCOMMANDS = new Set([
	"status", "log", "diff", "show", "blame", "describe", "shortlog",
	"reflog", "ls-files", "ls-remote", "cat-file", "version", "help",
	"whatchanged", "annotate", "var", "verify-commit", "verify-tag",
	"verify-pack", "hash-object", "count-objects", "merge-base", "name-rev",
]);

/** Global git options that consume the following token. */
const GLOBAL_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

/** Read-only flags for `git branch` (bare listing forms). */
const BRANCH_READONLY_FLAGS = new Set(["-a", "-r", "-v", "-vv", "-av", "-rav", "--list", "--all", "--show-current", "--verbose"]);

/** True when the segment contains an unquoted file redirection (`>`, `>>`), ignoring fd-duplication forms (`2>&1`, `>&2`, …). */
function hasFileRedirect(segment: string): boolean {
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i]!;
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		// `>` followed by `&` is fd duplication (2>&1, >&2), not a file write.
		if (ch === ">" && segment[i + 1] !== "&") return true;
	}
	return false;
}

/**
 * Classify one command segment.
 *  - `git` invocation → commit / push / read-only-git / mutating-git
 *  - anything else → non-git
 */
export function classifySegment(segment: string): SegmentClassification {
	const tokens = tokenize(segment);
	let i = 0;
	// Skip shell call operators (PowerShell `&`, bash `!`).
	while (i < tokens.length && (tokens[i] === "&" || tokens[i] === "!")) i++;
	if (i >= tokens.length || !/^git(\.exe)?$/i.test(tokens[i]!)) {
		return { segment, verb: "non-git" };
	}
	i++;
	// Skip global options (and their values) before the subcommand.
	while (i < tokens.length && tokens[i]!.startsWith("-")) {
		i += GLOBAL_OPTIONS_WITH_VALUE.has(tokens[i]) ? 2 : 1;
	}
	const rest = tokens.slice(i);
	const sub = rest[0]?.toLowerCase() ?? "";
	const args = rest.slice(1);

	if (!sub) {
		return { segment, verb: "mutating-git", subcommand: "(none)" };
	}
	if (sub === "commit") return { segment, verb: "commit", subcommand: sub };
	if (sub === "push") return { segment, verb: "push", subcommand: sub };

	const mutating = (): SegmentClassification => ({ segment, verb: "mutating-git", subcommand: sub });
	const readonly = (): SegmentClassification => ({ segment, verb: "read-only-git", subcommand: sub });

	if (READONLY_SUBCOMMANDS.has(sub)) return readonly();

	// Subcommands whose read-only-ness depends on arguments.
	switch (sub) {
		case "branch":
			// Bare listing or listing flags only.
			return args.every((a) => a.startsWith("-") && BRANCH_READONLY_FLAGS.has(a)) ? readonly() : mutating();
		case "tag":
			// Bare `git tag` lists; `git tag -l` lists; anything else creates/deletes.
			return args.length === 0 || ["-l", "--list"].includes(args[0]!) ? readonly() : mutating();
		case "remote":
			// Bare / -v lists; `remote get-url` reads.
			return args.length === 0 || ["-v", "--verbose"].includes(args[0]!) || args[0] === "get-url" ? readonly() : mutating();
		case "config":
			// Only value-reading forms.
			return ["--get", "--get-all", "--get-regexp", "--get-url", "-l", "--list"].includes(args[0] ?? "") ? readonly() : mutating();
		case "stash":
			return ["list", "show"].includes(args[0] ?? "") ? readonly() : mutating();
		case "worktree":
			return args[0] === "list" ? readonly() : mutating();
		default:
			// Unknown git subcommand: fail closed for git while sealed.
			return mutating();
	}
}

/** Classify a full (possibly compound) shell command. */
export function classifyCommand(command: string): CommandClassification {
	const result: CommandClassification = {
		segments: [],
		commitCount: 0,
		pushCount: 0,
		mutatingGitCount: 0,
		readonlyGitCount: 0,
		nonGitCount: 0,
		commitPending: false,
		pushPending: false,
	};
	for (const segment of splitCommandSegments(command)) {
		let cls = classifySegment(segment);
		if ((cls.verb === "read-only-git" || cls.verb === "non-git") && hasFileRedirect(segment)) {
			// Redirecting output writes a file: treat as a shell mutation.
			cls = { segment, verb: "mutating-git", subcommand: cls.subcommand ?? "(redirect)" };
		}
		result.segments.push(cls);
		switch (cls.verb) {
			case "commit": result.commitCount++; break;
			case "push": result.pushCount++; break;
			case "mutating-git": result.mutatingGitCount++; break;
			case "read-only-git": result.readonlyGitCount++; break;
			case "non-git": result.nonGitCount++; break;
		}
	}
	result.commitPending = result.commitCount > 0;
	result.pushPending = result.pushCount > 0;
	return result;
}

/** File-mutating built-in tools refused while sealed. */
export function isFileMutationTool(toolName: string): boolean {
	return toolName === "edit" || toolName === "write";
}

/** Seal decision for a shell command, by state. Pure decision table. */
export function evaluateShellCommand(state: SealState, command: string): SealDecision {
	if (state === "unsealed") {
		return { action: "allow", detail: "unsealed" };
	}
	const c = classifyCommand(command);
	if (c.commitCount > 0) {
		return { action: "block", detail: `git commit while sealed (${state})` };
	}
	if (c.pushCount > 0) {
		if (state === "awaiting-push" && c.pushCount === 1 && c.mutatingGitCount === 0) {
			return { action: "allow-push-once", detail: "single git push in awaiting-push" };
		}
		return { action: "block", detail: `git push not allowed (${state})` };
	}
	if (c.mutatingGitCount > 0) {
		return { action: "block", detail: `mutating git subcommand while sealed (${state})` };
	}
	return { action: "allow", detail: `read-only git / non-git segments (${state})` };
}
