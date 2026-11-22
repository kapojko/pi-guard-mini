/**
 * guard-mini — config resolution and defaults.
 *
 * Defaults are resolved at use time. The config file is never created or
 * populated automatically: only keys the user sets explicitly via /guard
 * are written, so an unset key always follows the current DEFAULT_* value
 * — a future default change applies to every install without pinning.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const AGENT_DIR = join(homedir(), ".pi", "agent");
export const CONFIG_PATH = join(AGENT_DIR, "guard-mini.json");

export const QWEN_MATCH = "qwen3.8";
/** Extra model ids (finetunes) accepted as Qwen3.8-family regardless of their base name. */
export const EXTRA_MODEL_MATCHES = ["daisyrose-27b"];
export const MODES = ["always", "qwen38-only", "disabled"] as const;
export const ENFORCEMENTS = ["gentle", "hard"] as const;

export type Mode = (typeof MODES)[number];
export type Enforcement = (typeof ENFORCEMENTS)[number];

/** Default mode for every feature when the config does not pin one. */
export const DEFAULT_MODE: Mode = "qwen38-only";
/** Default enforcement when the config does not pin one. */
export const DEFAULT_ENFORCEMENT: Enforcement = "gentle";

export interface GuardConfig {
	promptMode?: Mode;
	thinkingMode?: Mode;
	sealMode?: Mode;
	enforcement?: Enforcement;
}

export function resolveMode(mode: Mode | undefined): Mode {
	return mode ?? DEFAULT_MODE;
}

export function resolveEnforcement(value: Enforcement | undefined): Enforcement {
	return value ?? DEFAULT_ENFORCEMENT;
}

/**
 * True when the model id belongs to the Qwen3.8 family (e.g. qwen3.8-27b,
 * swift-1.5-qwen3.8-27b) or is a known finetune of it (e.g. daisyrose-27b).
 */
export function isQwenModel(modelId: string | undefined): boolean {
	const id = (modelId ?? "").toLowerCase();
	return id.includes(QWEN_MATCH) || EXTRA_MODEL_MATCHES.some((m) => id.includes(m));
}

/** Is a feature with this configured mode active for the given model? */
export function modeActive(mode: Mode | undefined, modelId: string | undefined): boolean {
	const resolved = resolveMode(mode);
	if (resolved === "always") return true;
	if (resolved === "qwen38-only") return isQwenModel(modelId);
	return false;
}

/** Read the raw config; missing file or invalid JSON -> {} (all defaults). */
export async function readConfig(): Promise<GuardConfig> {
	try {
		return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as GuardConfig;
	} catch {
		return {};
	}
}

/**
 * Merge an explicit user patch into the config file. Only keys the user set
 * via /guard are ever written; defaults are never materialized here.
 */
export async function writeConfig(patch: Partial<GuardConfig>): Promise<void> {
	const merged: GuardConfig = { ...(await readConfig()), ...patch };
	await mkdir(AGENT_DIR, { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(merged, null, "\t") + "\n", "utf8");
}
