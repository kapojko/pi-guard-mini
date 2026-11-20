/**
 * guard-mini — hallucinated-instruction guard for the pi coding agent.
 *
 * Three independent features, each with mode `always | qwen38-only | disabled`
 * (default `qwen38-only`, matched when the model id contains "qwen3.8"):
 *
 *   prompt        — injects a short damper section into the system prompt
 *                   (texts.ts: PROMPT_SECTION_TEXT).
 *   thinkingGuard — scans the first thinking block of each completed
 *                   assistant response for hallucinated-user-instruction
 *                   patterns (see detect.ts). v1 is gentle: detections steer
 *                   the model (texts.ts: REPEAT_STEER_TEXT /
 *                   DANGEROUS_STEER_TEXT); `enforcement: "hard"` in the
 *                   config switches dangerous classes to block + terminate.
 *   gitSeal       — per-session state machine
 *                   unsealed -> awaiting-push -> pushed over recognized
 *                   `git commit` / `git push` tool commands (see seal.ts).
 *                   While sealed, git mutations, edit/write, and shell
 *                   redirections are refused (texts.ts: SEAL_REFUSAL_TEXT);
 *                   only `/guard unseal` lifts the seal.
 *
 * Command:
 *
 *   /guard                 — status: model, modes, enforcement, seal state,
 *                            detection counts for this session.
 *   /guard prompt|thinking|seal [mode]
 *                          — set a feature mode (opens a selection dialog
 *                            when the mode is omitted).
 *   /guard enforcement [gentle|hard]
 *   /guard unseal          — lift the git seal.
 *
 * Defaults live in config.ts and are resolved at use time; the config file
 * only ever holds keys the user set explicitly via /guard.
 *
 * All detections, seal transitions, and refusals are appended to
 * ~/.pi/agent/guard-mini-incidents.jsonl. The session transcript is never
 * modified. Fail-open: a detector or IO error never blocks a tool by itself.
 *
 * Model-facing texts live in texts.ts (see README, "Model-facing texts").
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	AGENT_DIR,
	isQwenModel,
	MODES,
	ENFORCEMENTS,
	modeActive,
	readConfig,
	resolveEnforcement,
	writeConfig,
	type Enforcement,
	type GuardConfig,
	type Mode,
} from "./config.ts";
import { detectGuard, DANGEROUS_CLASSES, type GuardMatch } from "./detect.ts";
import { classifyCommand, evaluateShellCommand, isFileMutationTool, type SealState } from "./seal.ts";
import {
	DANGEROUS_BLOCK_TEXT,
	DANGEROUS_STEER_TEXT,
	PROMPT_SECTION_TEXT,
	REPEAT_STEER_TEXT,
	SEAL_REFUSAL_TEXT,
} from "./texts.ts";

// ── Tunables ────────────────────────────────────────────────────────────

const LOG_PATH = join(AGENT_DIR, "guard-mini-incidents.jsonl");
const SCANNED_CACHE_LIMIT = 16;
/** Footer status prefix: shield symbol, no colon. */
const STATUS_PREFIX = "🛡 ";
/**
 * Footer status key. The footer sorts extension statuses alphabetically by
 * key, so the key must outrank the other installed statuses:
 * "pi-permission-system" (yolo) < "pps-tps" < "z-proxy" < this.
 */
const STATUS_KEY = "zz-guard";

/** Structural subset of ExtensionContext used by the helpers below. */
interface UiCtx {
	model?: { id: string };
	sessionManager: { getSessionId(): string };
	ui: {
		setStatus(id: string, text: string | undefined): void;
		notify(msg: string, kind: "info" | "warning" | "error"): void;
	};
}

interface IncidentRecord {
	ts: string;
	feature: "prompt" | "thinking" | "seal";
	session: string;
	model: string;
	epoch: number;
	entryId?: string;
	toolCallId?: string;
	toolName?: string;
	guardClass?: string;
	rule?: string;
	excerpt?: string;
	genuineExcerpt?: string;
	action: string;
	enforcement: Enforcement;
	detail?: string;
}

// ── Extension ────────────────────────────────────────────────────────────

export default function guardMini(pi: ExtensionAPI): void {
	// In-memory state (rebuilt on session_start).
	let config: GuardConfig = {};
	let epoch = 0;
	let steeredThisEpoch = new Set<string>();
	let scanned = new Map<string, GuardMatch[]>();
	let lastGenuinePrompt: string | undefined;
	let seal: SealState = "unsealed";
	let pendingCommits = new Map<string, boolean>(); // toolCallId -> command also contained a push
	let pendingPushId: string | null = null;

	// ── incident log ──

	async function appendIncident(rec: IncidentRecord): Promise<void> {
		try {
			await mkdir(AGENT_DIR, { recursive: true });
			await appendFile(LOG_PATH, JSON.stringify(rec) + "\n", "utf8");
		} catch {
			// Fail-open: logging must never break the agent.
		}
	}

	async function sessionCounts(sessionId: string): Promise<Record<string, number>> {
		let text: string;
		try {
			text = await readFile(LOG_PATH, "utf8");
		} catch {
			return {};
		}
		const counts: Record<string, number> = {};
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const rec = JSON.parse(line) as IncidentRecord;
				if (rec.session === sessionId) {
					counts[rec.action] = (counts[rec.action] ?? 0) + 1;
				}
			} catch {
				// Skip malformed lines.
			}
		}
		return counts;
	}

	// ── status line ──

	function updateStatus(ctx: UiCtx): void {
		const modelId = ctx.model?.id;
		const flags = [
			modeActive(config.promptMode, modelId) && "prompt",
			modeActive(config.thinkingMode, modelId) && "think",
			modeActive(config.sealMode, modelId) && "seal",
		].filter(Boolean);
		// Effectively off (no feature active for this model): write nothing.
		if (flags.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		let text = `${STATUS_PREFIX}${flags.join("+")}`;
		if (seal !== "unsealed") text += ` · ${seal}`;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	// ── seal transitions ──

	async function setSeal(
		ctx: UiCtx,
		state: SealState,
		reason: string,
	): Promise<void> {
		seal = state;
		pi.appendEntry("guard-mini-seal", { state, at: new Date().toISOString(), reason });
		ctx.ui.notify(`guard-mini: git seal -> ${state} (${reason})`, state === "unsealed" ? "info" : "warning");
		await appendIncident({
			ts: new Date().toISOString(),
			feature: "seal",
			session: ctx.sessionManager.getSessionId(),
			model: ctx.model?.id ?? "",
			epoch,
			action: `seal:${state}`,
			enforcement: resolveEnforcement(config.enforcement),
			detail: reason,
		});
		updateStatus(ctx);
	}

	// ── thinking guard core ──

	function safeDetect(message: unknown, genuinePrompt: string | undefined): GuardMatch[] {
		try {
			return detectGuard(message as Parameters<typeof detectGuard>[0], genuinePrompt);
		} catch {
			return []; // Fail-open.
		}
	}

	/** Log suppressed (grounded) matches once at scan time. */
	async function logSuppressed(
		ctx: UiCtx,
		sessionId: string,
		entryId: string | undefined,
		matches: GuardMatch[],
	): Promise<void> {
		for (const m of matches) {
			if (!m.grounded) continue;
			await appendIncident({
				ts: new Date().toISOString(),
				feature: "thinking",
				session: sessionId,
				model: ctx.model?.id ?? "",
				epoch,
				entryId,
				guardClass: m.guardClass,
				rule: m.rule,
				excerpt: m.excerpt,
				genuineExcerpt: lastGenuinePrompt?.slice(0, 200),
				action: "suppressed",
				enforcement: resolveEnforcement(config.enforcement),
			});
		}
	}

	/**
	 * Act on non-grounded matches not yet handled this epoch.
	 * Returns true when hard enforcement wants the tool call blocked.
	 */
	async function actOnMatches(
		ctx: UiCtx,
		sessionId: string,
		entryId: string | undefined,
		matches: GuardMatch[],
		toolCallId: string | undefined,
		toolName: string | undefined,
	): Promise<boolean> {
		let block = false;
		for (const m of matches) {
			if (m.grounded) continue;
			if (steeredThisEpoch.has(m.guardClass)) continue;
			steeredThisEpoch.add(m.guardClass);
			const hard = resolveEnforcement(config.enforcement) === "hard" && DANGEROUS_CLASSES.includes(m.guardClass);
			if (hard) {
				block = true;
				ctx.ui.notify(`guard-mini: ${m.guardClass} detection — run blocked (${m.rule})`, "error");
			} else {
				const text = m.guardClass === "repeat" ? REPEAT_STEER_TEXT : DANGEROUS_STEER_TEXT;
				pi.sendMessage({ customType: "guard-mini", content: text, display: true }, { deliverAs: "steer", triggerTurn: true });
				ctx.ui.notify(
					`guard-mini: ${m.guardClass} detection — steered (${m.rule})`,
					m.guardClass === "repeat" ? "warning" : "error",
				);
			}
			await appendIncident({
				ts: new Date().toISOString(),
				feature: "thinking",
				session: sessionId,
				model: ctx.model?.id ?? "",
				epoch,
				entryId,
				toolCallId,
				toolName,
				guardClass: m.guardClass,
				rule: m.rule,
				excerpt: m.excerpt,
				genuineExcerpt: lastGenuinePrompt?.slice(0, 200),
				action: hard ? "blocked" : "steered",
				enforcement: resolveEnforcement(config.enforcement),
			});
		}
		return block;
	}

	function rememberScan(key: string, matches: GuardMatch[]): void {
		scanned.set(key, matches);
		if (scanned.size > SCANNED_CACHE_LIMIT) {
			scanned.delete(scanned.keys().next().value as string);
		}
	}

	// ── events ──

	pi.on("session_start", async (_event, ctx) => {
		config = await readConfig();
		epoch = 0;
		steeredThisEpoch = new Set();
		scanned = new Map();
		pendingCommits = new Map();
		pendingPushId = null;
		lastGenuinePrompt = undefined;
		seal = "unsealed";
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "guard-mini-seal") {
				const state = (entry.data as { state?: string } | undefined)?.state;
				if (state === "unsealed" || state === "awaiting-push" || state === "pushed") {
					seal = state;
				}
			}
		}
		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	// Genuine user input (typed / RPC / mid-stream steering) advances the
	// input epoch; extension-injected messages never do.
	const lastUserText = (text: string | Array<{ type: string; text?: string }> | undefined): string | undefined => {
		if (!text) return undefined;
		if (typeof text === "string") return text.trim() ? text : undefined;
		const joined = text.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n").trim();
		return joined || undefined;
	};

	pi.on("input", async (event) => {
		if (event.source === "extension") return;
		epoch++;
		steeredThisEpoch = new Set();
		const text = lastUserText(event.text);
		if (text) lastGenuinePrompt = text;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!modeActive(config.promptMode, ctx.model?.id)) return;
		event.systemPromptOptions.sections["guard-mini"] = PROMPT_SECTION_TEXT;
	});

	pi.on("tool_call", async (event, ctx) => {
		const modelId = ctx.model?.id;
		const sessionId = ctx.sessionManager.getSessionId();

		// ── git seal ──
		if (modeActive(config.sealMode, modelId)) {
			if (isFileMutationTool(event.toolName)) {
				if (seal !== "unsealed") {
					ctx.ui.notify(`guard-mini: ${event.toolName} refused — git seal active (${seal}); /guard unseal to lift`, "error");
					await appendIncident({
						ts: new Date().toISOString(),
						feature: "seal",
						session: sessionId,
						model: modelId ?? "",
						epoch,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						action: "refused",
						enforcement: resolveEnforcement(config.enforcement),
						detail: `${event.toolName} while ${seal}`,
					});
					return { block: true, reason: SEAL_REFUSAL_TEXT };
				}
			} else if (event.toolName === "powershell" || event.toolName === "bash") {
				const command = typeof (event.input as { command?: unknown })?.command === "string"
					? (event.input as { command: string }).command
					: "";
				if (command) {
					const decision = evaluateShellCommand(seal, command);
					if (decision.action === "block") {
						ctx.ui.notify(`guard-mini: command refused — git seal active (${seal}); /guard unseal to lift`, "error");
						await appendIncident({
							ts: new Date().toISOString(),
							feature: "seal",
							session: sessionId,
							model: modelId ?? "",
							epoch,
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							excerpt: command.slice(0, 200),
							action: "refused",
							enforcement: resolveEnforcement(config.enforcement),
							detail: decision.detail,
						});
						return { block: true, reason: SEAL_REFUSAL_TEXT };
					}
					if (decision.action === "allow-push-once") {
						pendingPushId = event.toolCallId;
					}
					if (seal === "unsealed") {
						const cls = classifyCommand(command);
						if (cls.commitCount > 0) {
							// A compound `commit && push` that succeeds seals straight to `pushed`.
							pendingCommits.set(event.toolCallId, cls.pushCount > 0);
						}
					}
				}
			}
		}

		// ── thinking guard (any tool call carries the completed assistant message) ──
		if (modeActive(config.thinkingMode, modelId)) {
			const entry = ctx.sessionManager.getLeafEntry();
			if (entry && entry.type === "message" && entry.message?.role === "assistant") {
				let matches = scanned.get(entry.id);
				if (matches === undefined) {
					matches = safeDetect(entry.message, lastGenuinePrompt);
					rememberScan(entry.id, matches);
					await logSuppressed(ctx, sessionId, entry.id, matches);
				}
				const block = await actOnMatches(ctx, sessionId, entry.id, matches, event.toolCallId, event.toolName);
				if (block) {
					return { block: true, reason: DANGEROUS_BLOCK_TEXT, terminate: true };
				}
			}
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!modeActive(config.sealMode, ctx.model?.id)) return;
		if (pendingCommits.has(event.toolCallId)) {
			const includesPush = pendingCommits.get(event.toolCallId) ?? false;
			pendingCommits.delete(event.toolCallId);
			if (!event.isError && seal === "unsealed") {
				await setSeal(
					ctx,
					includesPush ? "pushed" : "awaiting-push",
					`git commit${includesPush ? " + push" : ""} executed (${event.toolCallId})`,
				);
			} else if (event.isError) {
				await appendIncident({
					ts: new Date().toISOString(),
					feature: "seal",
					session: ctx.sessionManager.getSessionId(),
					model: ctx.model?.id ?? "",
					epoch,
					toolCallId: event.toolCallId,
					action: "seal:unchanged",
					enforcement: resolveEnforcement(config.enforcement),
					detail: "recognized git commit failed; seal not applied",
				});
			}
		}
		if (pendingPushId === event.toolCallId) {
			pendingPushId = null;
			if (!event.isError && seal === "awaiting-push") {
				await setSeal(ctx, "pushed", `git push executed (${event.toolCallId})`);
			} else if (event.isError && seal === "awaiting-push") {
				await appendIncident({
					ts: new Date().toISOString(),
					feature: "seal",
					session: ctx.sessionManager.getSessionId(),
					model: ctx.model?.id ?? "",
					epoch,
					toolCallId: event.toolCallId,
					action: "seal:unchanged",
					enforcement: resolveEnforcement(config.enforcement),
					detail: "recognized git push failed; allowance not consumed",
				});
			}
		}
	});

	// Tool-less responses: observe at turn_end (nothing to block there).
	pi.on("turn_end", async (event, ctx) => {
		if (!modeActive(config.thinkingMode, ctx.model?.id)) return;
		if (event.outcome !== "completed") return;
		const sessionId = ctx.sessionManager.getSessionId();
		let matches = scanned.get(event.messageEntryId);
		if (matches === undefined) {
			matches = safeDetect(event.message, lastGenuinePrompt);
			rememberScan(event.messageEntryId, matches);
			await logSuppressed(ctx, sessionId, event.messageEntryId, matches);
		}
		await actOnMatches(ctx, sessionId, event.messageEntryId, matches, undefined, undefined);
	});

	// ── rendering ──

	pi.registerMessageRenderer("guard-mini", (message, options, theme) => {
		const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		return new Text(theme.fg("warning", content), options.outputPad, 0);
	});

	pi.registerEntryRenderer("guard-mini-seal", (entry, _options, theme) => {
		const data = entry.data as { state?: string; reason?: string } | undefined;
		return new Text(
			theme.fg("dim", `guard-mini seal: ${data?.state ?? "?"}${data?.reason ? ` (${data.reason})` : ""}`),
			0,
			0,
		);
	});

	// ── command ──

	pi.registerCommand("guard", {
		description: "guard-mini: status, feature modes (prompt/thinking/seal), enforcement, unseal",
		handler: async (args: string, ctx) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const sub = argv[0];

			if (sub === "unseal") {
				if (seal === "unsealed") {
					ctx.ui.notify("guard-mini: not sealed.", "info");
					return;
				}
				await setSeal(ctx, "unsealed", "manual /guard unseal");
				return;
			}

			if (sub === "prompt" || sub === "thinking" || sub === "seal") {
				const key = sub === "prompt" ? "promptMode" : sub === "thinking" ? "thinkingMode" : "sealMode";
				let mode = argv[1] as Mode | undefined;
				if (mode !== undefined && !MODES.includes(mode)) {
					ctx.ui.notify(`guard-mini: unknown mode "${mode}" (always | qwen38-only | disabled)`, "error");
					return;
				}
				if (mode === undefined) {
					mode = await ctx.ui.select(`${sub} mode:`, [...MODES]) as Mode | undefined;
					if (mode === undefined) return;
				}
				await writeConfig({ [key]: mode } as Partial<GuardConfig>);
				config = await readConfig();
				ctx.ui.notify(`guard-mini: ${sub} mode = ${mode}`, "info");
				updateStatus(ctx);
				return;
			}

			if (sub === "enforcement") {
				let value = argv[1] as Enforcement | undefined;
				if (value !== undefined && !ENFORCEMENTS.includes(value)) {
					ctx.ui.notify(`guard-mini: unknown enforcement "${value}" (gentle | hard)`, "error");
					return;
				}
				if (value === undefined) {
					value = await ctx.ui.select("enforcement:", [...ENFORCEMENTS]) as Enforcement | undefined;
					if (value === undefined) return;
				}
				await writeConfig({ enforcement: value });
				config = await readConfig();
				ctx.ui.notify(`guard-mini: enforcement = ${value}`, value === "hard" ? "warning" : "info");
				return;
			}

			if (sub !== undefined) {
				ctx.ui.notify(
					"guard-mini: usage: /guard [prompt|thinking|seal|enforcement [value]] | /guard unseal",
					"error",
				);
				return;
			}

			// Status.
			const modelId = ctx.model?.id ?? "?";
			const counts = await sessionCounts(ctx.sessionManager.getSessionId());
			const countText = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ") || "none";
			const modeLine = (mode: Mode | undefined) =>
				`${mode ?? "qwen38-only"}${mode === undefined ? " (default)" : ""}${modeActive(mode, modelId) ? " [active]" : ""}`;
			ctx.ui.notify(
				[
					`model: ${modelId}${isQwenModel(modelId) ? " (qwen3.8 match)" : ""}`,
					`prompt: ${modeLine(config.promptMode)}`,
					`thinking: ${modeLine(config.thinkingMode)}`,
					`seal: ${modeLine(config.sealMode)}`,
					`enforcement: ${config.enforcement ?? "gentle"}${config.enforcement === undefined ? " (default)" : ""}`,
					`seal state: ${seal}`,
					`detections this session — ${countText}`,
				].join("\n"),
				"info",
			);
		},
	});
}
