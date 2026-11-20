# pi-guard-mini

Pi extension: a small, deterministic guard against **hallucinated user
instructions** (the model acting on a "New request: …" that was never sent)
and a **git commit/push seal** that stops autonomous work after the
requested commit/push boundary.

Born from two documented incidents on a local Qwen3.8 stack:

- `TODO_pi_hallucinated_instruction` — the model acted on a novel phantom
  instruction right after a `git commit`+`git push`.
- `TODO_pi_user_repeated` — the model repeatedly believed the user
  resent the same message after tool calls.

Design constraints (v1): no embeddings, no secondary LLM, no shell
interpreter re-implementation, fail-open on internal errors, and the
session transcript is never modified. All detections are **gentle** by
default (steering messages, not blocks).

## Features

Three independent features, each with mode `always | qwen38-only | disabled`
(default `qwen38-only`; the model id must contain `qwen3.8`):

| Feature | What it does |
|---|---|
| `prompt` | Injects a short damper section into the system prompt. |
| `thinking` (thinkingGuard) | Scans the first thinking block of each completed assistant response for hallucinated-user-instruction patterns; steers the model once per detection class per genuine-input epoch. |
| `seal` (gitSeal) | `unsealed → awaiting-push → pushed` state machine over recognized `git commit` / `git push` tool commands; blocks git mutations, `edit`/`write`, and shell redirections while sealed. |

`enforcement: "gentle"` (default) steers on every detection.
`enforcement: "hard"` additionally blocks + terminates the run for the
dangerous classes. Switch when you trust the detector's precision.

## Install

As a package in `~/.pi/agent/settings.json`:

```json
{ "packages": ["git:github.com/kapojko/pi-guard-mini"] }
```

For development:

```bash
pi -e ./extensions/guard-mini/index.ts
```

## Command

```
/guard                          — status: model, modes, enforcement, seal state, session detection counts
/guard prompt    [mode]         — set prompt feature mode (opens a dialog when omitted)
/guard thinking  [mode]
/guard seal      [mode]
/guard enforcement [gentle|hard]
/guard unseal                  — lift the git seal (the only way in v1)
```

## Configuration

`~/.pi/agent/guard-mini.json`:

```json
{
	"promptMode": "qwen38-only",
	"thinkingMode": "qwen38-only",
	"sealMode": "qwen38-only",
	"enforcement": "gentle"
}
```

Incident log (JSONL, append-only): `~/.pi/agent/guard-mini-incidents.jsonl`
— timestamp, session/model ids, epoch, entry/tool ids, class, rule, matched
excerpt, genuine prompt excerpt, action (`steered` / `suppressed` /
`blocked` / `refused` / `seal:*`).

## Model-facing texts

**Every phrase that reaches the model lives in
[`extensions/guard-mini/texts.ts`](extensions/guard-mini/texts.ts)** — the
injected prompt section, the steering messages, and the seal/block refusal
reasons. Tune wording there; nothing is composed or duplicated elsewhere.
TUI-only notifications never reach the model.

## Detection rules (thinkingGuard)

Detection surface: the **first thinking block** of a completed assistant
response. "Line" = text between `\n` characters of that block's text.

- **Anchored rules** apply only to the **first non-empty line**:
  - *new-instruction* — `New request:` / `Another task:` … (dangerous)
  - *reversal* — claimed user request to undo / roll back / revert /
    reset / cancel / abort / not commit (dangerous)
  - *fabricated-approval* — claimed user "yes / go ahead / proceed /
    approved / confirmed / agreed" (dangerous)
  - *repeat* — `The user repeated / resent / is repeating / keeps
    resending …` (soft)
- **Role-marker rules** apply across the whole first block: a line
  consisting only of `user`, or a ChatML `<|im_start|>user` marker
  (dangerous).

**Grounding suppression:** a match is suppressed (logged, no steering)
when the genuine user prompt plausibly contains the claimed content —
whole-line or ≥ 20-char claimed-content containment, or per-class keyword
(prompt carries approval/reversal/marker vocabulary). This is what keeps
incident-investigation sessions (quoting a previous phantom) quiet. The
rules bias toward suppression: in gentle mode a missed detection costs one
lost steering message, a false positive costs a wrong correction.

Actions: *repeat* → allow the tool, steer once per epoch
(`REPEAT_STEER_TEXT`); dangerous classes → allow the tool, steer once per
epoch (`DANGEROUS_STEER_TEXT`) + user notification; `hard` enforcement →
block + terminate instead. Every trigger (including suppressed) is logged.

## Git seal

Recognizes direct `git commit` / `git push` verbs in `powershell` / `bash`
tool commands, including compound commands (quote-aware splitting on
`;`, `&&`, `||`, `|`, `&`, newlines; global git options like `-C` /
`-c` handled).

- A **successful** recognized commit → `awaiting-push`.
- In `awaiting-push`, one directly recognized `git push` (alone or
  sharing the command with read-only git) is allowed; success → `pushed`.
  A failed push does not consume the allowance.
- While sealed: `edit` / `write` and mutating git subcommands (unknown
  git subcommands included — fail-closed for git) are refused with
  `SEAL_REFUSAL_TEXT`; read/search tools and read-only git always pass.
- Seal state persists in the session (`pi.appendEntry`) and survives
  reload/resume. Only `/guard unseal` lifts it.

Known coverage limits (by design, not bugs): indirect execution
(python/scripts), multi-repo `-C` edge cases, non-git shell mutations
(`npm install`, `Set-Content`, …) pass while sealed, and `!` user bash
commands do not affect the seal.

## Testing

```bash
npm test      # unit + archived-session replay (node --test, no deps needed)
npm run check # tsc type check
```

The replay suite (`tests/replay.test.ts`) gates the exact archived
corpus: the phantom line-96 entry (new-instruction), the six repeat
examples, and 14 ordinary grounded `The user said/asked …` entries must
not match. Fixtures were extracted from the two incident session
archives plus synthetic grounding/role-marker/near-miss cases.

### Manual e2e checklist (with a running model)

1. `pi -e ./extensions/guard-mini/index.ts` — no load errors; footer shows
   `🛡 prompt+think+seal` for a qwen3.8 model (nothing when effectively off).
2. `/guard` — status block; `/guard prompt disabled` and dialog variants.
3. Scratch git repo: ask the model to commit → seal transitions to
   `awaiting-push` (footer + `/guard`); a following edit/write or
   `git commit` is refused with the seal reason; one `git push` passes →
   `pushed`; further mutations refused; `/guard unseal` clears.
4. Prompt section: ask the model to quote its guard-mini system-prompt
   section, or inspect `ctx.getSystemPrompt()` via a debug extension.

**Not yet e2e-tested:** the thinking-guard steering path against a real
model (needs a model that actually exhibits the hallucinated-turn
behavior, or a scripted imitator extension that injects artificial
"dangerous" assistant messages). Postponed deliberately — see
`TODO_imitator.md` ideas; unit/replay tests cover the detector logic.

## Layout

```
extensions/guard-mini/
  index.ts   — wiring: events, /guard command, renderers, config, logging
  texts.ts   — ALL model-facing texts (tuning point)
  detect.ts  — pure thinking-guard detector
  seal.ts    — pure git command classifier + seal decision table
tests/
  detect.test.ts, seal.test.ts, replay.test.ts, fixtures/
```
