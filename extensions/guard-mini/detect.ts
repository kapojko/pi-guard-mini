/**
 * guard-mini — thinking-guard detector. Pure functions, no pi imports, no
 * side effects. Unit-tested in isolation and against archived-session
 * fixtures (tests/).
 *
 * Detection surface: the FIRST `thinking` block of a completed assistant
 * message. "Line" means a substring between `\n` characters of that
 * block's text; the first thinking block has no finer-grained structure.
 *
 *  - Anchored rules (new-instruction, repeat, reversal, fabricated-approval)
 *    apply ONLY to the first non-empty line of the block.
 *  - Role-marker rules (a line consisting only of `user`, or a ChatML
 *    `<|im_start|>user` marker) are searched across the whole block.
 *
 * Grounding suppression: a match is marked `grounded` when the genuine user
 * prompt plausibly contains the claimed content (whole-line containment,
 * >= 20-char claimed-content containment, or per-class keyword). Grounded
 * matches are logged as `suppressed` and never acted on. The rules are
 * deliberately biased toward suppression: the cost of a missed detection in
 * gentle mode is one lost steering message, while the cost of an ungrounded
 * false positive is a wrong correction sent to the model.
 */

export type GuardClass =
	| "repeat"
	| "new-instruction"
	| "reversal"
	| "fabricated-approval"
	| "role-marker";

/** Classes treated as dangerous (block + terminate in hard mode; steered in gentle mode). */
export const DANGEROUS_CLASSES: readonly GuardClass[] = [
	"new-instruction",
	"reversal",
	"fabricated-approval",
	"role-marker",
];

export interface ContentBlock {
	type: string;
	thinking?: string;
	text?: string;
}

export interface AssistantMessageLike {
	role?: string;
	content: ContentBlock[];
}

export interface GuardMatch {
	guardClass: GuardClass;
	/** Rule id, e.g. "new-instruction:first-line" or "role-marker:bare-user-line". */
	rule: string;
	/** Matched line (first-line rules) or marker context (role markers), truncated to excerptMax. */
	excerpt: string;
	/** 0-based line index within the first thinking block. */
	lineIndex: number;
	/** True when grounded in the genuine user prompt (suppressed; never acted on). */
	grounded: boolean;
}

export interface DetectOptions {
	/** Max characters kept in GuardMatch.excerpt. Default 200. */
	excerptMax?: number;
}

// ── Tunables ────────────────────────────────────────────────────────────

const DEFAULT_EXCERPT_MAX = 200;
/** Minimum normalized length of a claimed-content fragment before containment grounding applies. */
const CLAIM_MIN_CHARS = 20;

// ── Anchored rules: first non-empty line of the first thinking block ────
// Priority order: new-instruction > reversal > fabricated-approval > repeat.
// A first line matches at most one anchored rule (the first in this order).

const NEW_INSTRUCTION_RE =
	/^(?:new|another|next|additional)\s+(?:request|task|instruction|feature)\s*:\s*(.*)$/i;

const REVERSAL_RE =
	/^the\s+user\s+(?:asked|wants|wanted|said|says|requested|told)\s+(?:me\s+)?(?:(?:not\s+to|do\s+not|don['’]t)\s+commit|(?:to\s+)?(?:undo|roll\s*back|rollback|revert|reset|cancel|abort)\b)(.*)$/i;

const FABRICATED_APPROVAL_RE =
	/^the\s+user\s+(?:(?:said|says)\s+(?:yes|go\s+ahead|proceed|okay|ok)\b|(?:approved|confirmed|agreed|authorized)\b)(.*)$/i;

const REPEAT_RE =
	/^the\s+user\s+(?:has\s+)?(?:repeated|resent|is\s+repeating|repeats|keeps\s+(?:repeating|resending|re-?sending))\b(.*)$/i;

// ── Role-marker rules: whole first thinking block ────────────────────────

/** A line consisting only of the word `user` (Claude Code "phantom user turn" signature). */
const BARE_USER_LINE = "user";
/** Qwen/ChatML synthetic user-turn marker. */
const CHATML_USER_MARKER = "<|im_start|>user";

// ── Grounding keyword rules (applied to the normalized genuine prompt) ───

const APPROVAL_KEYWORD_RE =
	/\b(?:yes|go ahead|proceed|okay|ok|approved|confirm(?:ed)?|agreed)\b/;
const REVERSAL_KEYWORD_RE =
	/\b(?:undo|roll\s*back|rollback|revert|reset|cancel|abort)\b/;

// ── Helpers ─────────────────────────────────────────────────────────────

export function normalize(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** First non-empty (after trim) line of a block of text; undefined when none. */
export function firstNonEmptyLine(
	text: string,
): { line: string; index: number } | undefined {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i]!.trim();
		if (trimmed) return { line: lines[i]!, index: i };
	}
	return undefined;
}

function truncate(text: string, max: number): string {
	const t = text.trim();
	return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

function isGrounded(
	guardClass: GuardClass,
	claimed: string,
	fullLine: string,
	markerText: string | undefined,
	genuinePrompt: string | undefined,
): boolean {
	if (!genuinePrompt) return false;
	const prompt = normalize(genuinePrompt);
	// Whole matched line quoted in the genuine prompt (investigation/quoting
	// case). Short lines (e.g. a bare `user`) are skipped: containing the
	// word "user" anywhere must not ground a match.
	if (normalize(fullLine).length >= CLAIM_MIN_CHARS && prompt.includes(normalize(fullLine))) return true;
	// Claimed content (the instruction/action fragment) quoted in the prompt.
	const claimedN = normalize(claimed);
	if (claimedN.length >= CLAIM_MIN_CHARS && prompt.includes(claimedN)) return true;
	// Per-class keyword grounding: the genuine prompt itself carries the
	// approval/reversal/marker vocabulary, so a matching claim is plausible.
	switch (guardClass) {
		case "fabricated-approval":
			return APPROVAL_KEYWORD_RE.test(prompt);
		case "reversal":
			return REVERSAL_KEYWORD_RE.test(prompt);
		case "role-marker":
			if (markerText === BARE_USER_LINE) {
				// A bare `user` line is too short for containment grounding;
				// ground only when the prompt itself shows a standalone `user`
				// line, or quotes/backticks the word (investigation case).
				return /(^|\n)\s*user\s*(\n|$)/.test(genuinePrompt) || /["'`]user["'`]/.test(genuinePrompt);
			}
			return markerText !== undefined && prompt.includes(normalize(markerText));
		default:
			return false;
	}
}

function firstThinkingBlock(
	message: AssistantMessageLike,
): string | undefined {
	for (const block of message.content ?? []) {
		if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
			return block.thinking;
		}
	}
	return undefined;
}

// ── Detector ────────────────────────────────────────────────────────────

/**
 * Detect hallucinated-user-instruction patterns in an assistant message.
 * Returns matches in priority order; grounded (suppressed) matches are
 * included with `grounded: true` — callers decide what to act on.
 */
export function detectGuard(
	message: AssistantMessageLike,
	genuinePrompt?: string,
	options?: DetectOptions,
): GuardMatch[] {
	const excerptMax = options?.excerptMax ?? DEFAULT_EXCERPT_MAX;
	const thinking = firstThinkingBlock(message);
	if (thinking === undefined) return [];
	const matches: GuardMatch[] = [];

	// Anchored rules: first non-empty line only.
	const first = firstNonEmptyLine(thinking);
	if (first) {
		const anchored: Array<[GuardClass, string, RegExp]> = [
			["new-instruction", "new-instruction:first-line", NEW_INSTRUCTION_RE],
			["reversal", "reversal:first-line", REVERSAL_RE],
			["fabricated-approval", "fabricated-approval:first-line", FABRICATED_APPROVAL_RE],
			["repeat", "repeat:first-line", REPEAT_RE],
		];
		for (const [guardClass, rule, re] of anchored) {
			const m = first.line.match(re);
			if (!m) continue;
			const claimed = m[1] ?? "";
			matches.push({
				guardClass,
				rule,
				excerpt: truncate(first.line, excerptMax),
				lineIndex: first.index,
				grounded: isGrounded(guardClass, claimed, first.line, undefined, genuinePrompt),
			});
			break; // at most one anchored match per first line
		}
	}

	// Role-marker rules: whole first thinking block.
	const lines = thinking.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === BARE_USER_LINE) {
			matches.push({
				guardClass: "role-marker",
				rule: "role-marker:bare-user-line",
				excerpt: truncate(line, excerptMax),
				lineIndex: i,
				grounded: isGrounded("role-marker", "", line, BARE_USER_LINE, genuinePrompt),
			});
			break;
		}
	}
	if (thinking.includes(CHATML_USER_MARKER)) {
		const idx = lines.findIndex((l) => l.includes(CHATML_USER_MARKER));
		matches.push({
			guardClass: "role-marker",
			rule: "role-marker:chatml-user",
			excerpt: truncate(lines[idx] ?? CHATML_USER_MARKER, excerptMax),
			lineIndex: idx >= 0 ? idx : 0,
			grounded: isGrounded("role-marker", "", CHATML_USER_MARKER, CHATML_USER_MARKER, genuinePrompt),
		});
	}

	return matches;
}
