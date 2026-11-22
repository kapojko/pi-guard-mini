/**
 * Tests for config resolution and defaults (extensions/guard-mini/config.ts).
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_ENFORCEMENT,
	DEFAULT_MODE,
	isQwenModel,
	modeActive,
	resolveEnforcement,
	resolveMode,
} from "../extensions/guard-mini/config.ts";

test("defaults: all features default to qwen38-only, enforcement to gentle", () => {
	assert.equal(DEFAULT_MODE, "qwen38-only");
	assert.equal(DEFAULT_ENFORCEMENT, "gentle");
	assert.equal(resolveMode(undefined), "qwen38-only");
	assert.equal(resolveEnforcement(undefined), "gentle");
});

test("modeActive: unset key follows the default (no pinning)", () => {
	// With no config entry at all, the feature must be active for qwen3.8 models.
	assert.equal(modeActive(undefined, "qwen3.8-27b"), true);
	assert.equal(modeActive(undefined, "qwen3.8-27b-single"), true);
	assert.equal(modeActive(undefined, "swift-1.5-qwen3.8-27b"), true);
	assert.equal(modeActive(undefined, "daisyrose-27b"), true);
	assert.equal(modeActive(undefined, "claude-opus-4"), false);
	assert.equal(modeActive(undefined, undefined), false);
});

test("modeActive: explicit modes override the default", () => {
	assert.equal(modeActive("always", "claude-opus-4"), true);
	assert.equal(modeActive("always", undefined), true);
	assert.equal(modeActive("disabled", "qwen3.8-27b"), false);
	assert.equal(modeActive("qwen38-only", "qwen3.8-27b"), true);
	assert.equal(modeActive("qwen38-only", "gpt-5"), false);
});

test("isQwenModel: substring match, case-insensitive", () => {
	assert.equal(isQwenModel("qwen3.8-27b"), true);
	assert.equal(isQwenModel("Qwen3.8-27B-Single"), true);
	assert.equal(isQwenModel("swift-1.5-qwen3.8-27b"), true);
	assert.equal(isQwenModel("qwen38-27b"), false); // no dot — not matched
	assert.equal(isQwenModel("daisyrose-27b"), true); // known Qwen3.8 finetune
	assert.equal(isQwenModel("DaisyRose-27B-UD"), true); // case-insensitive substring
	assert.equal(isQwenModel("/mnt/models/daisyrose-27b-gguf"), true);
	assert.equal(isQwenModel(""), false);
	assert.equal(isQwenModel(undefined), false);
});
