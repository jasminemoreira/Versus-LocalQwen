# Versus for Local Qwen

**IACDM orchestrator for local models served by Ollama in VS Code Agent Mode.**

Same methodology as [Versus · Copilot](https://marketplace.visualstudio.com/items?itemName=JasmineMoreira.versus-copilot) and [Versus · Claude](https://marketplace.visualstudio.com/items?itemName=JasmineMoreira.versus-claude): eight sequential phases, adversarial critique lenses, verification gates, and a decision registry that survives context loss. What differs is the operating regime — and one failure mode that only appears with local models.

## The failure this extension exists to catch

A frontier model behind an API degrades gracefully when a conversation gets long. A local model on a hybrid attention architecture does not.

Models in the `qwen35` family (Qwen3.5, Qwen3.6 and relatives) interleave full attention with linear/SSM layers — `full_attention_interval = 4` means only one layer in four keeps a conventional KV cache. Linear-layer state cannot be partially evicted, so llama.cpp reports:

```
KV cache shifting is not supported for this context, disabling KV cache shifting
the context does not support partial sequence removal
```

Without context shifting there is no sliding window and no graceful degradation. When the prompt fills `n_ctx`, the prompt is **clipped** — and the runner starts with `--keep 4`, so what survives is the first four tokens, not the tool definitions. Generation then stops mid-emission.

**No error. No exception. No stop reason the host surfaces.** The visible symptom is a turn that ends with *"I'll create the files now!"* and no tool call. It reads as the model losing the thread. It is the model hitting a wall.

### Why it triggers far earlier than it should

The Ollama VS Code provider resolves the context window in `sharedContextWindow()` with this precedence:

1. `show.parameters.num_ctx`
2. `PARAMETER num_ctx` in the modelfile
3. any `model_info` key ending in `.context_length`
4. a 32768 fallback

Most published tags pin no `num_ctx`, so resolution falls through to step 3 — the model's **architectural** maximum. For `qwen3.6:27b` that is `262144`. Subtract the provider's 4096 output reserve and VS Code advertises **258048 input tokens** to the chat host.

Meanwhile the server honours `OLLAMA_CONTEXT_LENGTH`, typically 32768 or 65536. The host budgets prompts against a window four to eight times larger than the one that exists. Every long turn is built to overflow.

This is why a truncated prompt often measures suspiciously close to `n_ctx` — 32635 tokens in a 32768 window, say. That is not a prompt that happened to fill the window. It is the clipped remainder of a much larger one.

## What this extension adds

| Surface | What it does |
|---|---|
| **`check_context_budget`** (MCP tool) | Called before any turn expected to emit a file, a critique or a long table. Reports the real window, what the host will advertise, VRAM residency, and whether a planned payload fits. Returns `ok: false` with an instruction to narrow scope, rather than trying and dying halfway. |
| **Status bar** | Polls `/api/ps` and `/api/show`. Shows the live window, flags a misaligned budget with its overflow factor, and flags CPU spill. The failure is invisible inside the conversation, so the warning comes from outside it. |
| **Align Model Context Window** (command) | Rewrites the model tag with `PARAMETER num_ctx` pinned, which wins the provider's precedence and closes the gap. The weights blob is referenced by digest, so nothing is re-downloaded and no disk is duplicated. |
| **Context discipline** | Injected into `.github/copilot-instructions.md`: one artifact per turn, never re-read a file already in context, never accept *"check what's missing and continue"*, and treat a cut-short turn as a failure rather than a success. |

### Sizing the window

Pin the largest window your GPU sustains **entirely** in VRAM. Measured on an RTX 4090 (24564 MiB) with `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0`, running `qwen3.6:27b` at Q4_K_M:

| `num_ctx` | `ollama ps` | VRAM used | headroom | processor |
|---|---|---|---|---|
| 32768 | 17 GB | 19846 MiB | 4.6 GB | 100% GPU |
| 65536 | 18 GB | 21074 MiB | 3.4 GB | 100% GPU |
| 131072 | 21 GB | 23565 MiB | 1.0 GB | 100% GPU |

65536 is the operating point. 128k fits, but a gigabyte of headroom is not enough when VS Code runs on Windows and Ollama in WSL — the desktop compositor competes for the same VRAM, and any figure under `PROCESSOR` other than 100% GPU means spillover.

The KV cache scales unusually gently here (32k→64k costs 1.2 GB) precisely because only 16 of the 64 layers hold a conventional cache. The property that makes the window cheap is the same one that makes overflow fatal.

## Compaction on a small window

Auto-compaction is designed behaviour, not a fault. The chat host summarises the
conversation *before* the window is full, holding back headroom for tool schemas
and the next response. On a 200k frontier model that headroom is invisible. On a
64k local model it is most of the session — and every compaction throws away
context the model then spends tokens reading back, which is what turns it into a
loop.

There is a setting for it, and on a local model it is the largest single lever
available — larger than anything on the Ollama side:

```jsonc
// unset by default; ratio of the window (0–1) or an absolute token count (≥100)
"github.copilot.chat.summarizeAgentConversationHistoryThreshold": 0.9
```

Or run **Versus LocalQwen: Set Compaction Threshold**, which writes it and
reports where compaction will now land.

Raising it is a real trade, not free headroom. Compaction is what keeps a
conversation inside the window; push it too close to the edge on an architecture
without KV cache shifting and an overflowing turn dies mid-emission instead of
being summarised. Leave room for the reply.

Two related settings, both from the bundled Copilot extension:

| Setting | Effect |
|---|---|
| `github.copilot.chat.summarizeAgentConversationHistory.enabled` | Master switch. `false` disables auto-compaction entirely — only sane with a threshold you trust and short sessions. |
| `github.copilot.chat.conversationCompaction.model` | Runs the summarisation on a different model. Compaction is itself an LLM call on your local model, so pointing it elsewhere gets the GPU back. |

### The estimator drift, measured

The Ollama provider does not tokenize. It keeps a chars-per-token ratio per
model, starting at 4, and recalibrates after each response:

```js
observedCharsPerToken = text.length / prompt_eval_count
ratio = (ratio + observedCharsPerToken) / 2
```

The two sides do not measure the same thing. `text.length` comes from
`partToText`, which returns `''` for tool calls, tool results and non-text data
parts; `prompt_eval_count` covers the whole prompt Ollama tokenized, tool
schemas and tool output included. In an agent session most of the prompt is
exactly what the numerator drops, so the ratio slides down every tool-heavy
turn and `countTokens` starts pricing text far above what the model charges.

Observed on qwen3.6 in a real session, against a probe of 355 chars whose true
cost is 81 tokens:

| moment | host counts | factor | 61440-token budget behaves like |
|---|---|---|---|
| healthy (ratio 4.0) | 89 | 1.10x | ~56000 |
| mid-session | — | 1.89x | ~32500 |
| after a few tool-heavy turns | 289 | **3.57x** | **17220** |

The 1.89x row is inferred from where prompts actually stopped growing in the
Ollama log; the other two are direct measurements. The progression is monotonic,
which is what the mechanism predicts.

At 3.57x a 64k window behaves like 17k, and that dominates every other factor on
this page. The status bar reports the live figure.

The ratio lives on the provider instance, not on the chat session — which is why
opening a new chat changes nothing and why the fix is **Restart Extension Host**
(cheaper than a window reload; editors and terminals survive). It re-accumulates
from there, so the warning re-arms after each reset.

This is an upstream bug in
[ollama/ollama-vscode](https://github.com/ollama/ollama-vscode): `record()`
should compare against the same text `count()` sees, or not recalibrate at all.

### Stopping it instead of managing it

The reset cycle does not survive contact with a real session. Recalibration is a
running average — `ratio = (ratio + observed) / 2` — so each turn moves halfway
to the bad value. One "resume the project" turn, which is almost entirely tool
results, takes 4.00 to about 1.8; the third turn is near 0.75. Resetting when the
status bar turns red means resetting every turn.

The repository ships a patch for it:

```bash
npm run patch-ollama      # apply
npm run unpatch-ollama    # restore the backup
```

It changes one line in the installed Ollama extension, clamping the ratio so it
cannot fall below the provider's own default of 4:

```js
this.charsPerToken.set(modelID, Math.max(defaultCharsPerToken,
  (currentCharsPerToken + observedCharsPerToken) / 2));
```

Upward calibration still works, so a model that genuinely runs coarser than 4
chars/token is still learned. Only the downward collapse is blocked — and that
collapse is an artifact of the mismatched numerator, not a measurement of
anything. The script backs up `provider.js` first, is idempotent, and finds the
extension under both `.vscode/extensions` and `.vscode-server/extensions`.

Because it edits a third-party extension, an Ollama update reverts it. Re-run the
script; the status bar tells you when it is needed.

Restart the extension host after applying — the provider is loaded once.

### When to reset (unpatched)

Versus tells you, so you do not have to watch it. The status bar always carries
the usable figure — `Versus: 56k usable` shading to `17k usable` as the session
wears on — and an offer appears when it drops below a floor:

```jsonc
// fraction of the registered budget below 1, absolute tokens at 100+, 0 to never prompt
"versus-localqwen.usableBudgetFloor": 0.66
```

Two rules shape when that offer appears, both learned the hard way:

**It waits for a gap between turns.** Restarting the extension host cancels any
request still streaming, so an offer that landed mid-turn would cost you the
work it was trying to protect. The provider only recalibrates when a response
finishes, so the probe's cost doubles as an activity signal: unchanged for two
polls means nothing is in flight.

**It is measured in tokens, not in the drift ratio.** 1.3x on a 200k window is
irrelevant and 1.3x on a 16k one is fatal, so the alert is about how much room
is left to work in.

Doing it by hand: reset between phases, or before any turn that needs a large
read. Never while the model is generating.


## Requirements

- **VS Code 1.120+.** Chat and agent mode ship in core; no Copilot subscription is needed.
- **[Ollama](https://marketplace.visualstudio.com/items?itemName=Ollama.ollama)** — publisher `Ollama`, blue verified badge. Several unverified extensions use the same llama icon; this is the one that registers the `ollama-models` provider exposing local models to the chat picker.
- **Node.js 18+** on PATH.
- A model with the `tools` capability. Check with `ollama show <model>`.

## Quick start

1. Install the Ollama extension, then **Ctrl+Shift+P → Chat: Manage Language Models → Add Models → Ollama**. Your model should appear; you may need **Unhide** before it becomes selectable in the chat picker.
2. Install this extension.
3. Run **Versus LocalQwen: Check Context Budget**. If it reports a misaligned or unpinned window, run **Versus LocalQwen: Align Model Context Window**, then reload.
4. Run **Versus LocalQwen: Initialize Project**.
5. Open a **new** chat session (Ctrl+Alt+I) — MCP servers and instruction files are only picked up when a session starts.
6. Type `start`.

At any point, typing `retomar Versus` in chat reloads phase, decisions and instructions.

> **VS Code on Windows, Ollama in WSL?** The server binds to `127.0.0.1` inside the VM and is invisible from the Windows host. Either point `versus-localqwen.ollamaUrl` at the VM IP, or reopen the folder in a WSL remote window — which resolves it without configuration.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `versus-localqwen.ollamaUrl` | `http://127.0.0.1:11434` | Must match the URL configured in the Ollama extension. |
| `versus-localqwen.model` | *(empty)* | Tag to monitor. Empty means the first loaded model. |
| `versus-localqwen.generationReserve` | `4096` | Tokens held back for generation. Mirrors the provider's own output reserve. |
| `versus-localqwen.statusBar` | `true` | Show context health in the status bar. |

## Differences from the sibling extensions

**No hooks.** Versus for Qwen ships seven Qwen Code CLI hooks — context injection, phase gating, loop detection, destructive-command blocking, truncation detection, stop verification. VS Code chat has no hook system. Those safeguards live inside MCP tool responses instead, and truncation detection moved to the status bar, where it can watch the server directly.

**No full-guidance injection.** Versus for Qwen injects the complete methodology on every `UserPromptSubmit`, betting on prompt caching to absorb the cost. That guidance tokenizes to **13861 tokens** on Qwen3.6 — over a fifth of a 64k window, every turn, before a single file is read. This extension keeps the Copilot design: guidance served per phase on demand through `get_phase_guidance`, costing 680 to 2900 tokens depending on the phase.

**Shared state.** `.versus/state.json` uses the same schema as the rest of the family, so a project can move between Versus for Claude, Copilot and this one without losing phase or decisions.

## A note on chat templates

`ollama show --modelfile qwen3.6:27b` reports `TEMPLATE {{ .Prompt }}` — thirteen characters, which looks broken. It is not. The lines below it read `RENDERER qwen3.5` and `PARSER qwen3.5`: Ollama 0.32+ formats chat and parses tool calls natively in Go, outside the runner. The `--no-jinja --chat-template chatml` flags visible on the runner process are harmless, because the runner receives text that is already rendered.

So when the model narrates an action in prose instead of calling a tool, look for the cause in the context budget, not the template.

## The methodology

Unchanged from the family. See the [Versus README](https://github.com/jasminemoreira/Versus) for the eight phases, the critical lenses, the coverage matrix, and the [IACDM preprint](https://arxiv.org/abs/2604.16399).

```
Phase 0: Problem Discovery    → HSA 5-level exploration (score >= 90 to advance)
Phase 1: Architecture         → Define modules, interfaces, patterns
Phase 2: Adversarial Critique → Attack the architecture with specialized lenses
Phase 3: Simplification       → Address criticals, simplify (loops with Phase 2)
Phase 4: Convergence Gate     → Validate all exit criteria + safeguards
Phase 5: Implementation       → Code the final architecture
Phase 6: Tests                → 100% passing + exploratory testing
Phase 7: Post-Review          → Double-loop learning: evaluate product AND process
```

Phase 2 is where a local model earns its keep. Critique operates on one unit at a time — a function is hundreds of tokens, not thousands — so it runs comfortably inside a window where agent mode strains. If critique holds up while agent mode struggles, that is empirical support for the granular design rather than a limitation of it.

## Author

**Jasmine Moreira** — Developer · Researcher · IACDM creator

## License

MIT.
