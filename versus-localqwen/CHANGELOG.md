# Changelog

## [0.5.0] - 2026-08-01

Upstream patch from Versus for Claude 0.11.0 (commit `c7e21a4`).

### Added

- **Exit gates require persisted evidence, not a boolean.** Marking a criterion
  met records a claim; four criteria now also require the artifact that claim
  refers to to exist on disk before the phase can advance:

  | Phase | Criterion | Evidence |
  |---|---|---|
  | 1 | `architecture_doc` | `specs/technical/architecture.md` |
  | 2 | `coverage_matrix` | `specs/design/coverage-matrix.md` |
  | 6 | `tests_passing` | a passing run witnessed in this phase |
  | 7 | `lessons_documented` | `specs/references/lessons.md` |

  The check is liveness, not quality: the file must exist and hold at least 80
  non-whitespace characters, which rejects an empty file or a lone heading. The
  guidance says so plainly rather than implying the engine reviews content. A
  blocked transition names the missing path, since a gate that refuses without
  saying what is missing is the dead end the `safeguardViolations` fix addressed.

  `start_new_cycle` is gated the same way on the lessons file: the next cycle
  inherits them, and a conversation about to be replaced is not where they live.

- **The MCP server re-reads state before every tool call.** It used to load once
  at startup, so a state written by another process — the extension host on
  init, or another window's server — was invisible for the rest of the session.
  The engine saves after each mutation, so disk is authoritative.

### Notes

The upstream spec tells this build to skip the `verify: "test-pass"` gate,
reasoning that without a `test-outcome` hook nothing writes `lastTestOutcome`
and the gate would block forever. That caveat predates 0.3.0: `record_test_outcome`
exists here as an MCP tool and feeds the same field, so the gate is applied.

The difference is worth naming. A hook observes a run whether or not the model
cooperates; a tool depends on the model calling it. So the block message names
`record_test_outcome(command, failed=false)` explicitly — without an escape the
model can actually reach, this gate would be a trap rather than a check.

## [0.4.2] - 2026-08-01

### Fixed

- **A project declaring `"type":"module"` silently disabled the methodology.**
  Node resolves module type from the nearest `package.json`, so a modern JS
  project marking itself ESM makes every `.js` under its tree an ES module —
  including the CommonJS bundle deployed to `.versus/localqwen/`. The MCP server
  then dies with `require is not defined in ES module scope` and Versus is
  simply absent from that project, with nothing saying why.

  A `package.json` holding `{"type":"commonjs"}` is now written beside the
  bundle, which pins the module type for that directory whatever the project
  declares. Applied to both deploy paths — `deployServer` in the extension host
  and `deployBundles` on the MCP side — since either can run first and the
  upstream note only covers the former.

  Retroactive fix for an already-broken project: reopening the workspace
  rewrites the deploy and creates the file.

  Origin: Versus for Claude 0.10.1 (commit 10435c8).

## [0.4.1] - 2026-08-01

### Fixed

- **The sibling-server warning nagged on every activation and overstated its
  case.** Coexistence is a deliberate design choice in the Versus family, so a
  modal-toned warning repeated at every startup — and once per open window —
  was interrupting about a permanent, accepted condition.

  It now shows once per workspace with a "Don't show again" option, is an
  information message rather than a warning, and always records to the output
  channel whether or not it interrupts. The claim was also wrong: it asserted
  the sibling's tools were "duplicated into every request", which depends on
  that server actually being enabled in this window — something this extension
  cannot see. It now says so and points at VS Code's MCP view.

- **Notifications fired about models the window was not using.** One Ollama
  server backs every VS Code window and `/api/ps` reports whatever is loaded
  globally, so a window working on qwen3.6 warned about `mistral:7b` — a model
  another window had loaded. With several windows open the same finding was also
  announced once per window.

  A notification now requires the model to be attributable to this window: the
  configured `versus-localqwen.model` matches it, or only one model has ever
  been seen through the shared server and this workspace has an initialised
  Versus project. The status bar still reports whatever is loaded; only the
  interruptions are scoped.

### Added

- **`check_context_budget` reports the fixed cost of the tool surface.** The 17
  tool definitions cost ~2577 tokens on every request before any conversation
  exists, and a window that cannot hold them truncates every turn regardless of
  how small the work is — which a payload-sized check never notices.

  Measured in the Ollama log over one day: all 17 truncations happened on
  windows of 8192 or below (13 of them at 2048), and none at 32k, 64k or 128k.
  At 2048 the schemas alone are 126% of the window, which is why a tool call
  there returns "Sorry, no response was returned": the definitions do not fit,
  so nothing is generated. This is a hard floor for the methodology, not a
  regression.

### Fixed (introduced and caught in the same change)

- The tool-surface cost was first computed inside `context-tools.ts` by
  importing `ALL_TOOLS` from the registry that imports it back. Loading
  `context-tools` first left the array holding an `undefined` entry and the tool
  crashed. The surface is now computed where the list lives and passed in. The
  unit test missed it because it required the registry directly, so it never
  reproduced the load order the MCP server uses.

## [0.4.0] - 2026-07-27

### Added

- **The Ollama estimator clamp is reapplied on activation.** An Ollama update
  installs into a new versioned directory, so the clamp is silently gone and the
  only symptom is the usable-tokens figure sliding again mid-session. Seen in
  practice within hours: 0.0.5 → 0.0.6, and a freshly restarted host already
  measured 1.80x. The provider's `record()` and `partToText` are byte-identical
  in 0.0.6, so nothing was fixed upstream — the patch simply went with the old
  directory.

  The check is silent when there is nothing to do. When it does reapply, it says
  so and asks for a restart, because the ordering cannot be worked around: by the
  time this extension activates, the Ollama extension has already loaded
  `provider.js` into memory, so a patch written now takes effect at the *next*
  host start and the current session still runs unclamped.

  A provider whose `record()` no longer matches the known line reads as
  `unknown-shape` and is left alone rather than guessed at — that is what an
  upstream fix would look like.

- **`versus-localqwen.autoPatchOllamaEstimator`** (default `true`) and the
  **Clamp Ollama Token Estimator** command, which asks before writing. Set the
  setting to `false` to be prompted instead, or to leave the provider untouched;
  `npm run unpatch-ollama` now points this out, since otherwise activation would
  quietly undo a deliberate revert.

### Changed

- The patch logic moved to `src/ollama/estimator-patch.ts` and
  `scripts/patch-ollama-estimator.mjs` became a thin front end over it. Two
  copies of a patch that edits someone else's extension is one copy too many.

## [0.3.2] - 2026-07-27

Upstream patch from Versus for Claude 0.10.0 (commit 0d2ef6c), adapted: the
search anchors in the spec are from the Claude build and this fork's text has
diverged, so each change was applied to the equivalent block rather than
pattern-matched.

### Changed

- **LLM Switch Points are now a decision, not a notice.** Both the forward
  switch (P4→P5) and the reverse switch (Phase 7 → new cycle) used to display a
  recommendation and then proceed, which puts the burden of interrupting on the
  user at the one moment where the choice is cheapest to make. Forward: it is
  free only *before* any code exists — once Phase 5 has written files, switching
  means abandoning a session mid-implementation. Reverse: free only before the
  new cycle's design work begins.

  Both now ask in chat (R2 format) and branch. On "Switch model" the model
  records a `process` decision and stops; on "Continue here" it proceeds.

- **`process` category documented in `record_decision`** — methodology and
  session decisions such as an LLM switch or a session renewal.

### Notes

Adaptations against the upstream spec, all preserving this fork's divergences:

- `advance_phase(target_phase=N)` keeps its explicit argument; upstream uses the
  bare call.
- The Phase 4 block keeps its `❌` branch (return to Phase 2 or 3), which the
  upstream text does not carry.
- Step 3 now states that the automatic pause message returned by
  `advance_phase(target_phase=5)` restates the same choice and must be
  acknowledged rather than asked again. `PHASE_PAUSE_MESSAGES` is a
  Copilot-line feature absent upstream, so the spec could not account for the
  interaction.
- Model names stay generic ("the target model", "the design-grade model")
  instead of Opus/Sonnet.

## [0.3.1] - 2026-07-27

### Fixed

- **Sibling extensions overwrote each other's MCP server.** Every Versus
  extension that ships an MCP server was deploying it to `.versus/server.js`,
  so in a workspace with more than one installed the file belonged to whichever
  activated last. Found in a live workspace: `.vscode/mcp.json` registered
  `versus-localqwen` while the binary at that path identified itself as
  `versus-claude` and exposed 15 tools instead of 17 — `check_context_budget`
  and `record_test_outcome` were simply absent, so the entire local-model guard
  layer was missing from a project that appeared to be running under it.

  It also explains the `TypeError: Cannot read properties of undefined (reading
  'invoke')` on the first tool call, and the "MCP server versus-claude may have
  new tools" prompt: the host advertised one server's tools while another's
  server answered, so the handle it looked up was not there.

  The bundle now lives in `.versus/localqwen/`, the convention the Qwen and Kimi
  siblings already use. `state.json` stays at `.versus/state.json`, shared on
  purpose so a project still moves between the extensions.

- **`.mcp.json` is no longer written.** It was there for Claude Code interop,
  but VS Code discovers that file too, so writing to it registered our server a
  second time and re-sent its whole tool schema on every request. Claude Code
  users can register the server themselves; the shared `state.json` is what
  actually carries a project across tools.

### Added

- **Sibling registration warning.** Removing our duplicate does not remove
  anyone else's: a workspace previously initialized by another Versus extension
  still carries its entry. On activation the extension now reports any other
  `versus-*` MCP server registered in the workspace, since each one re-sends
  ~2500 tokens of duplicate tool schemas per turn and leaves the model choosing
  between same-named tools with nothing to go on.

## [0.3.0] - 2026-07-27

Audit against Versus for Claude 0.9.0, the canonical line. The fork base
(Copilot 0.8.0) turned out not to be simply behind — both lines had moved — so
only what Claude genuinely gained was ported, and the divergences where the
Copilot line is ahead were deliberately kept.

### Added

- **S6 loop detection, ported from Claude 0.9.0.** In the fork base the S6
  safeguard had no check at all: `validateS6` never returned `violated`, nothing
  cleared the counter, and `record_decision(category='diagnosis')` — the escape
  hatch the message promised — did nothing. The counter also counted test
  *executions*, the design Claude abandoned because it blocks the passing run,
  the one moment S4 (execute and verify) explicitly requires.

  Ported: `LOOP_FAILURE_THRESHOLD`, `DIAGNOSIS_CATEGORIES`, the S6 `violated`
  check, `recordTestOutcome` (failures only; a green run clears), `clearLoopCredit`,
  `lastDiagnosis` on `LoopCounter`, and `record_decision` clearing the counter on
  a diagnosis category.

- **`record_test_outcome` MCP tool.** The sibling extensions feed the counter
  from CLI hooks — a `PostToolUse` hook reads every shell command's exit status.
  VS Code chat has no hooks, so without a tool the ported counter would sit at
  zero forever and S6 would report `ok` while the model looped: a safeguard that
  looks alive and is dead.

  This is a weaker guarantee and is documented as one — a hook observes the run
  whether or not the model cooperates, while a tool depends on the model calling
  it. What it does buy is enforcement the model cannot route around: a violated
  S6 vetoes the next `advance_phase()` through `validatePhaseTransition`.

- **`normalizeCommandPattern` keeps the suite argument.** `npm test -- consent`
  and `npm test -- link` both collapsed to `test:js`, compounding failures from
  unrelated suites into one counter — though the S6 clause speaks of iterations
  on the same *module*.

### Fixed

- **A vetoed phase transition reported an empty reason.** `validatePhaseTransition`
  computed `safeguardViolations` and the error object discarded them, so a
  transition blocked by a safeguard returned `Cannot advance from Phase X to
  Phase Y.` with nothing in `missingCriteria` — a dead end with no way to act.
  Surfaced through `advance_phase`.

### Notes

Kept from the Copilot line, which is ahead of Claude 0.9.0 on these and must not
be "restored":

- **R2 asks in chat with a numbered template.** Claude routes every user decision
  through `AskUserQuestion`, a Claude Code tool that does not exist in this host.
  Roughly fifteen "via AskUserQuestion" call sites are correspondingly rewritten.
- `advance_phase(target_phase=N)` with the argument spelled out, rather than a
  bare `advance_phase()`.
- Phase 0 AFTER SCORE branches on three score bands, not two.
- Richer P2 exit-gate semantics for the 2↔3 loop, and a longer
  `activated_lenses_recorded` criterion that names all twelve conditional lenses
  and states that absence of findings is a valid result.
- The P6 manual-testing handoff split into AI actions / user actions / AI actions
  on return.
- `PHASE_PAUSE_MESSAGES` for the 5, 6 and 7 transitions.
- Model names kept generic ("a smaller/cheaper LLM") instead of Opus/Sonnet.

Not ported: `markExitCriteria` (batch), which is unreferenced dead code in
Claude 0.9.0, and the CLI hooks, which have no host here.

## [0.2.4] - 2026-07-27

### Added

- **`npm run patch-ollama`** — clamps the Ollama provider's chars-per-token ratio
  so it cannot fall below its own default of 4. Upward calibration is preserved;
  only the downward collapse is blocked, and that collapse measures nothing real,
  since it comes from dividing a numerator that excludes tool parts by a
  denominator that includes them.

  The reset cycle shipped in 0.2.3 does not survive a real session: the running
  average moves halfway to the bad value each turn, so one "resume the project"
  turn takes the ratio from 4.00 to ~1.8 and the third reaches ~0.75. Resetting
  on the red status bar would mean resetting every turn. The patch removes the
  cycle instead of managing it.

  Backs up `provider.js`, is idempotent, searches both `.vscode/extensions` and
  `.vscode-server/extensions`, and reverts with `npm run unpatch-ollama`. An
  Ollama update reverts it too — re-run the script.

## [0.2.3] - 2026-07-27

### Changed

- **The drift alert now triggers on usable tokens, not on the drift ratio.** A
  ratio is not comparable across models: 1.3x on a 200k window is irrelevant and
  fatal on a 16k one. The new `versus-localqwen.usableBudgetFloor` setting
  (default `0.66`, a fraction of the registered budget; `100`+ reads as absolute
  tokens; `0` never prompts) expresses the alert in the only terms that matter —
  how much room is left to work in.
- **The offer waits for a gap between turns.** Restarting the extension host
  cancels any request still streaming, so prompting mid-turn would cost the work
  it is meant to protect. The provider only recalibrates once a response
  finishes, so the calibration probe's cost doubles as an activity signal:
  unchanged across two polls means nothing is in flight.
- **The status bar leads with the usable figure** — `Versus: 17k usable` rather
  than `est 3.6x off`. The ratio is the cause; the tokens are the consequence,
  and the consequence is what informs a decision.

## [0.2.2] - 2026-07-27

### Changed

- **Estimator drift confirmed as dominant, and the framing corrected.** 0.2.1
  called it a contributing factor because its magnitude had never been measured.
  It has now been measured in a live session: the host counted the 355-char
  probe as 289 tokens against a true cost of 81 — a factor of **3.57x**, which
  makes a 61440-token budget behave like 17220. An earlier point in the same
  session implies ~1.89x, so the slide is monotonic, as the mechanism predicts.
  Past 2x the status bar now shows this as an error rather than a warning.
- **Remedy is now Restart Extension Host, not Reload Window.** The ratio lives
  on the provider instance, so restarting the extension host clears it without
  tearing down the renderer — editors and terminals survive. Falls back to a
  window reload where the command is unavailable.

### Fixed

- The summary line in **Check Context Budget** reported `Verdict: ok` while the
  headline said the estimator was 3.57x off. The verdict now accounts for drift.
- The drift warning fired once per model and never again, so it stayed silent
  after a reset even as the ratio slid back down. It now re-arms once the factor
  returns to healthy.

## [0.2.1] - 2026-07-27

### Added

- **Compaction threshold surfaced and settable.** Early compaction on a small
  window is mostly the host doing what it is designed to do: it summarises
  before the window is full, holding back headroom for tool schemas and the next
  response. That headroom is invisible on a 200k model and most of the session
  on a 64k one. The threshold is configurable via
  `github.copilot.chat.summarizeAgentConversationHistoryThreshold` (unset by
  default), so the status bar now reports where compaction will land and a new
  command — **Set Compaction Threshold** — writes it.

- **Token estimator telemetry.** The Ollama provider does not tokenize. It keeps
  a chars-per-token ratio per model, starting at 4, and recalibrates it after
  each response as `text.length / prompt_eval_count`. The numerator comes from
  `partToText`, which returns `''` for tool calls, tool results and non-text
  parts, while the denominator covers the whole prompt — so the two sides do not
  measure the same thing and the ratio can drift away from reality in a
  tool-heavy session.

  How much it drifts in practice was previously unknowable, so the extension now
  measures it: a fixed probe is tokenized with the model's own tokenizer via
  `prompt_eval_count`, the host is asked to count the same string with
  `countTokens`, and the ratio between them is reported. On qwen3.6 the probe is
  355 chars and 81 real tokens (4.38 chars/token), so the provider's untouched
  default of 4 already overcounts by ~10%.

  This is a contributing factor to early compaction, not the main one — see the
  README on the host's compaction threshold. Calibration only runs when the
  model is already resident, so a background poll never pulls weights into VRAM
  or competes with a session using the GPU.

### Fixed

- `measureTokens` ran its two probes concurrently. Ollama reuses a cached prompt
  prefix between concurrent requests to the same model and then reports only the
  newly evaluated tokens, so the difference was meaningless and the measurement
  returned null. The probes now run sequentially.

## [0.2.0] - 2026-07-27

### Added

- **Host-side budget measurement** — the status bar now reads what the chat
  host actually registered for the model via `vscode.lm.selectChatModels`,
  instead of reconstructing it from the Ollama provider's resolution rules.
  Reconstruction only ever described the server side; the host can disagree for
  reasons the server cannot see.
- **`under` verdict** — host budget far below the server window. Nothing is
  clipped, so the existing checks stayed silent, but it is exactly what makes a
  session compact every few turns while most of the window sits unused. Offers
  a window reload, which is the actual fix.

### Changed

- `init_project`'s description shrank from ~767 to ~438 tokens. Tool schemas are
  re-sent on every request, so the brownfield protocol moved into
  `get_phase_guidance(0)`, which is fetched once. Saves ~329 tokens per request.
- `get_phase_guidance(0)` now answers before a project exists. It carries the
  protocol for calling `init_project` correctly, so gating it behind an
  initialized project was circular.

## [0.1.0] - 2026-07-26

First release. Forked from Versus for Copilot 0.8.0, which shares the VS Code
chat host, and adapted to local models served by Ollama.

### Added

- **`check_context_budget` MCP tool** — reports the window the Ollama server
  actually loaded, the budget the chat host will advertise, VRAM residency, and
  whether a planned payload fits. Returns `ok: false` with an instruction to
  narrow scope. Exempt from the gateway guard, since it is what you call to find
  out whether there is room to load context at all.
- **Context health status bar** — polls `/api/ps` and `/api/show` every 15s.
  Distinguishes three states: `aligned`, `misaligned` (host budget provably
  exceeds the loaded window) and `unpinned` (nothing pins `num_ctx`, so the host
  will advertise the architectural maximum). Also flags CPU spill.
- **`Align Model Context Window` command** — rewrites a model tag with
  `PARAMETER num_ctx` pinned, which wins the Ollama provider's resolution
  precedence and closes the gap between advertised and real windows. Confirmed
  with a modal before rewriting; the weights blob is referenced by digest, so
  nothing is re-downloaded.
- **`Check Context Budget` command** — the same reading, on demand.
- **Context discipline section** in the generated
  `.github/copilot-instructions.md`: one artifact per turn, never re-read a file
  already in context, refuse "check what's missing and continue", and treat a
  cut-short turn as a failure rather than a success.
- Settings: `ollamaUrl`, `model`, `generationReserve`, `statusBar`. Passed to
  the MCP server through `${config:...}` in `.vscode/mcp.json`, so the server
  tracks settings changes without the file being rewritten.

### Changed

- Prerequisite check now requires the **Ollama** extension (publisher `Ollama`)
  instead of GitHub Copilot. Chat and agent mode ship in VS Code core since
  1.104, so no subscription is involved. Engine bumped to `^1.120.0`, the
  minimum for the Ollama provider.
- `state.json` is stamped `agent: "localqwen"`. The schema is unchanged, so a
  project still moves freely between the Versus extensions.
- `.claude/settings.json` now receives only tool permissions. The previous
  version also installed Claude Code hooks pointing at bundles this extension
  does not deploy.

### Removed

- The six CLI hook entry points inherited from the Claude Code and Qwen Code
  lineage. VS Code chat has no hook system, so they were dead weight; the
  bundler now has a single entry point. Their safeguards live in MCP tool
  responses and in the status bar instead.

### Notes

Guidance is served per phase on demand via `get_phase_guidance` (680–2900
tokens), not injected wholesale on every prompt. The complete methodology
tokenizes to 13861 tokens on Qwen3.6 — over a fifth of a 64k window per turn,
which the sibling Qwen extension absorbs with prompt caching and a local model
cannot.
