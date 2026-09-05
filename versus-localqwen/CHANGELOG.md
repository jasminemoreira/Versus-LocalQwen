# Changelog

## [0.13.2] - 2026-09-05

### Fixed

- **Every `ask_user` dialog was a two-page form.** The client renders one form
  property per step, so the optional "Anything to add" field turned each question
  into a "2/2" wizard to click through — most of what made a question feel heavy.
  The schema now carries a single property.

  The escape from a closed list moved into the list: a final "Other — let me
  answer in my own words" entry. Picking it returns `open-answer-requested` and
  tells the model to ask again with no options, so a free-text field costs a round
  trip only when someone wants one, instead of a second page on every question.
  Nothing is reported as the user's answer in that case — the model is told not to
  guess what they meant.

## [0.13.1] - 2026-09-03

Patch: one timed-out `ask_user` no longer sends the model to chat for the rest of
the session.

### Fixed

- **After an `ask_user` timeout, the model gave up on the tool.** This host aborts
  a pending elicitation when the person is slow to answer. The model correctly
  fell back to the chat block for that question — but then kept asking in chat for
  every question after it, as if the tool had gone away. It hadn't: calling
  `ask_user` again works immediately (confirmed — an explicit "ask again with
  `ask_user`" always succeeds).

  R2 told the model to fall back on a failed call but never told it the failure
  was transient. Added that: a timeout is the host cancelling a slow answer, not
  the tool disappearing, so the fallback covers only that one question and the
  model must resume `ask_user` on the next decision. No host or timeout change —
  the timeout is the client's and not configurable; this is the behavioral half
  the guidance was missing.

## [0.13.0] - 2026-09-03

Minor bump: the instruction file stops fixing a format, and starts being kept up
to date.

### Fixed

- **The project's instruction file contradicted the guidance it was served.**
  `.github/copilot-instructions.md` spelled out the chat-block question format
  verbatim, down to "Reply with the number (e.g. `1`)". Since 0.12.0 the guidance
  tells the model to call `ask_user` where the host can show a dialog — two
  instructions, and the file is the one loaded into every request. The model
  followed the file, which is the reasonable thing to do.

  Traced by elimination that actually eliminated: with the real client
  capabilities, the project's own server serves R2 saying "call `ask_user`" and
  the string "Reply with the number" appears **nowhere** in the phase 0 guidance —
  yet the model wrote it verbatim. It came from the file.

  The file now delegates: "HOW to ask is decided at run time, and rule R2 in the
  phase guidance says which way." It cannot know at creation time whether the host
  will offer elicitation, so it no longer pretends to.

- **The instruction file was written once and never refreshed.**
  `if (content.includes("versus")) return` meant every project kept the text it
  was born with — the same defect shape as the frozen server binary and the
  `mcp.json` env missing a variable. It is now fenced with
  `<!-- versus:begin -->` / `<!-- versus:end -->` and refreshed on activation. A
  legacy block, written before the fences, is replaced from its heading onwards;
  anything the user wrote before or after is left alone, which is under test.

### Changed

- Both writers — the extension's and the MCP server's — call one
  `writeAgentInstructions`. The comment claimed they shared content "so the two
  can never disagree"; they duplicated the logic, and only the content was shared.

### Notes

- Two of my conclusions this round were wrong and were corrected by measurement,
  not by argument: that VS Code does not offer elicitation (the capability log
  shows `elicitation, roots, sampling, tasks`), and that the model was ignoring
  the instruction to stop (it does stop — it just used the format the file gave
  it).

## [0.12.3] - 2026-09-03

### Added

- **The negotiated capability is written to `.versus/mcp-client.log` as well as to
  stderr.** The stderr line lands in the MCP server's output channel, three steps
  away and easy to confuse with the extension's own — the first attempt to read it
  produced the wrong channel, and the second produced the right one from a run
  that predated the logging. The file is one line, rewritten at every start, in
  the directory the project already owns:

  ```
  2026-09-03T13:00:32.327Z vscode 1.120
  offers: elicitation, roots
  elicitation available — ask_user will open a dialog the model cannot answer
  ```

  It answers the question that recurs every time a question arrives as prose:
  whether the host declined to show a dialog, or the model ignored its
  instructions. From the chat those look identical.

## [0.12.2] - 2026-09-03

### Added

- **The server reports what the client offered, on stderr.** Whether a question
  reaches a person as a dialog or as a chat block is decided by a capability
  negotiated at initialize, and there was no way to see which had happened — a
  question written as prose looks identical whether the host declined elicitation
  or the model ignored its instructions. Two lines in the MCP output channel now
  say which:

  ```
  [versus] client <name> <version> offers: elicitation, roots
  [versus] elicitation available — ask_user will open a dialog the model cannot answer
  ```

  or, when it is not offered, that `ask_user` falls back to a chat block, "which
  stops the model only if it chooses to stop".

### Notes

- Verified end to end against the binary deployed in a real project: with a client
  declaring `elicitation`, R2 comes out pointing at the tool, `ask_user` issues the
  `elicitation/create` request with the options as an enum, and the reply returns
  as `answered`. Our side of this works.
- So when the questions still arrive as chat blocks, the negotiation is where to
  look — not the tool. The process running in that window was confirmed to be the
  current binary, started after the deploy, which rules out staleness.

## [0.12.1] - 2026-09-03

### Changed

- **The ask-user command reads as the override it became.** Since 0.12.0 Versus
  asks through MCP elicitation and needs no configuration, but the palette entry
  still sat among the ordinary setup commands as though it were a step. It is now
  "Override Ask-User Tool (advanced)", the picker opens by saying the default
  needs no setting, and clearing the override reads as "keep the default (MCP
  elicitation)" rather than "ask in chat" — which is what it used to mean and
  would now be a downgrade.
- The setting's own description says the same, so it is not discovered as a
  required step from the settings UI either.

### Notes

- The command appears in the palette with or without a project open: commands are
  contributed by the extension, not by the workspace. Deleting a project does not
  remove one, and nothing about it is per-project except the value it writes.

## [0.12.0] - 2026-09-03

Minor bump: a new tool, and the ask-user question stops needing configuration.

### Added

- **`ask_user`, backed by MCP elicitation.** The methodology's questions were
  chat blocks, which stop the model only as far as the model chooses to stop —
  against an agentic model, not far: phases advanced with the questions answered
  by the model itself. Elicitation is the protocol's own answer: the server asks,
  the client renders a dialog, and the value comes back from the person. The model
  cannot supply it, cannot skip it, and cannot mistake its own reasoning for a
  decision that was made.

  R2 now points at it wherever the client negotiated the capability — **no setting
  and no tool name to type**. `versus-localqwen.askUserTool` is demoted to an
  override for a host with a tool of its own, and the chat block stays as the
  fallback where neither exists.

### Fixed

- **Four tests were passing vacuously.** The runner called `fn()` and printed the
  tick without awaiting, so an async assertion failed only into a non-zero exit
  code while the line above it claimed a pass. Verified by breaking one on
  purpose: it printed ✓. Async cases are queued and awaited now, and the same
  broken assertion prints ✗.

### Notes

- Declining and dismissing are reported as themselves, never as an answer, with
  instructions that do not invite the model to decide instead.
- A host without elicitation gets a plain `elicitation-unavailable` status naming
  the fallback, not an error — an error would send the model hunting for a
  different tool.
- Verified against the installed SDK (1.26.0) and the capability the client sends
  at initialize; VS Code has supported elicitation since the 2025-06-18 spec.
- The tool surface grew from 18 tools to 19, 3221 to 3434 tokens.
- This partly retires 0.11.1 through 0.11.5 — the setting, the picker and its
  ranking. That work was not wasted: it is what showed that GLM's `ask_user` is
  not in `vscode.lm.tools` at all, which is what sent me looking at the protocol.

## [0.11.5] - 2026-09-02

### Changed

- **The ask-user choice is a yes/no where there is an obvious answer.** It was a
  list of forty tools for a decision that is really on or off. When exactly one
  registered tool scores above the rest, the command now asks "Ask the user
  through a tool?" with three entries: yes through that one, no and ask in chat,
  or open the full list. In the window this was reported from, that resolves to
  `vscode_askQuestions` — the only tool there named for asking questions rather
  than for confirmations.

  A tie at the top is not a winner: two equally named tools open the full list
  instead of a confident guess between them.

### Fixed

- **`open_browser_page` and `run_in_terminal` were being offered as ask-user
  tools.** They reached the shortlist through phrases in their descriptions —
  prose that mentions prompts and confirmations in passing. Scoring now reads the
  NAME only: a tool built to ask is named for it, and every attempt to infer
  intent from description text has produced false candidates. Two rounds of them.
- Names are graded rather than accepted flatly: asking a question (`ask`,
  `question`, `choice`, `elicit`) outranks asking for approval (`confirm`,
  `prompt`), because a yes/no is not a question with options — which is what the
  methodology's R2 block is.

### Notes

- Nothing is filtered from the full list, still. A harness may name its tool
  something no pattern anticipates, and hiding it would send the user back to
  typing a name from memory.

## [0.11.4] - 2026-09-02

### Fixed

- **The ask-user picker ranked by a word that is in half the catalogue.** The
  first pattern matched "user" anywhere, and nearly every tool description says
  it — "helps the user create project structures", "if the user mentions errors".
  Everything scored as a candidate, the ranking collapsed to alphabetical, and
  the list gave no help deciding. Reported from a real window, where
  `copilot_createNewWorkspace` and `copilot_getErrors` sat at the top.

  The signal is now the tool's purpose: a name built around asking (`ask_user`,
  `confirm`, `promptUser`, `elicit`), or a whole phrase that only appears when a
  tool waits for someone — "asks the user", "waits for the response", "requests
  confirmation". Those descriptions are pinned in a test so this cannot come back.

### Changed

- The picker separates "Looks like it asks the user" from "Everything else
  registered here", so the candidates are visible rather than merely first. When
  nothing qualifies, the heading says so — that is the answer to "which do I
  pick?" when the window simply has no such tool, and manual entry is right below.
- The title says the list is filterable, since typing `ask` finds it faster than
  scrolling past forty entries.

## [0.11.3] - 2026-09-02

### Added

- **`Versus LocalQwen: Choose Ask-User Tool` in the command palette.** Setting
  `askUserTool` meant editing settings.json by hand and typing a tool name from
  memory — and a name that is registered nowhere makes the model call something
  absent, mid-phase. The picker lists the tools the window actually has, from
  `vscode.lm.tools`, with the plausible ones first: anything whose name or
  description mentions asking, prompting, confirming, input, a user or a choice.

  Nothing is filtered out, only reordered. A harness may name its tool something
  the pattern never anticipated, and hiding it would send the user back to typing
  from memory — the mistake the picker exists to prevent. "None — ask in chat"
  is always the first entry, and manual entry stays available for a tool this
  window cannot see.

### Notes

- Written to Workspace settings when a folder is open, Global otherwise: the same
  machine runs different models in different windows, and the tool belongs to
  whichever harness that project talks to. The confirmation says which scope it
  used.
- The MCP server reads `VERSUS_ASK_USER_TOOL` once, when VS Code spawns it, so the
  choice only reaches the guidance after a restart. The confirmation offers
  Reload Window rather than leaving that to be discovered.
- The ranking is a pure function in `src/ask-tool.ts`, apart from the command, so
  the part worth getting right — which entries reach the top of a list that can
  hold dozens — is tested without an extension host.

## [0.11.2] - 2026-09-02

### Fixed

- **`get_phase_state` was being written to disk instead of shown to the model.**
  The guidance pagination in 0.10.0 fixed the payload that was spilling then; the
  state snapshot grew past the same limit since. Measured on the live projects:
  RestaUm returned **11.4 KB** and Goitacaz **49 KB**, against a host that keeps a
  tool result inline only up to about 5.7 KB. Six spills in September, all of them
  this call — and it is the gateway guard, the one call the model is told to make
  before anything else, so what was lost was the project's state.

  Now 4.7 KB and 5.4 KB respectively, both inline.

### Changed

- **The spec reaches the model as values.** Since 0.7.0 each entry carries
  `{ value, phase, at }`; the stamp costs about 50 characters, which is five
  kilobytes across a hundred entries, for metadata the model never reads. It
  exists so an external analysis can date the spec from `state.json`, and that is
  where it stays.
- **Both collections are budgeted, and what was dropped is said.** Decisions are
  shortened before any is dropped, and the note points at `get_decisions` and
  gives the true count. Spec entries are never truncated — they run 27 to 50
  characters and each is a distinct commitment, so half a constraint reads as a
  different constraint; whole entries are dropped from the oldest end instead, and
  counted. Each list gets a share of the budget proportional to its length with a
  floor, so 200 stack entries cannot push two constraints out of the snapshot.
- The `command` of the last test outcome is capped at 160 characters. One real
  record held an entire heredoc — 2 KB of shell inside a state snapshot.

### Notes

- This answers a question worth recording: whether GLM would do better with the
  full guidance injected instead of the paginated one. No — the spill limit is a
  property of the chat host, not of the model or the provider, and September's
  spills prove it still applies. Full injection would put the guidance straight
  back on disk. What the evidence did show is that the guidance is now fine and
  the state snapshot was the one being lost.

## [0.11.1] - 2026-09-02

### Added

- **`versus-localqwen.askUserTool`: the questions go through a real tool where the
  host has one.** R2 has always said every user decision is asked directly in
  chat, and that works only as far as the model chooses to stop: a question
  written as prose does not yield the turn. GLM's harness exposes an `ask_user`
  tool; Qwen's does not, which is why the rule was written as a chat block in the
  first place. When the setting names a tool, R2 tells the model to put every
  decision through it — a tool call does yield the turn — keeping the same option
  shape, and falling back to the chat block if the call fails.

  Reported symptom this addresses: running against GLM, the phases advanced
  without any question ever reaching the user.

### Notes

- **Configured, never inferred from the model name.** The tool comes from the
  harness, not from the weights: the same model behind another endpoint may not
  have it. A name list would also go stale — the `qwen3.6` → `qwen3.8` swap
  already broke a pinned assumption this month — and guessing wrong means the
  model calls a tool that is not there, mid-phase. Empty by default, so nothing
  changes for the Qwen path.
- The rule reaches the model through R2, which is a global rule and therefore
  lands in part 1 of every phase — the one part a model that ignores the
  `_nextAction` chain will still have read. A test pins that for four phases.
- Delivery changes; the question does not. The option block, the recommended-first
  ordering and the one-question-per-ask rule are identical in both variants, so a
  project run either way is asking the same things.
- The chat-block variant also gained the sentence it was missing: after asking,
  stop the turn. Continuing past an unanswered question is deciding it alone.

## [0.11.0] - 2026-08-30

Minor bump: a new setting, and `Align now` stops proposing one machine's number
to every machine.

### Added

- **The context window suggestion is computed from the GPU, not asserted.**
  `Align now` used to default to 65536 — the window this developer's card
  sustains. On a 24 GB card that leaves ~1.8 GB for the desktop, and a heavier
  desktop pushes the KV cache into system RAM, where generation falls 20-50x and
  the session reads as frozen with no error anywhere. Pinning `num_ctx` is what
  puts a user on that edge: without the pin Ollama picks a smaller window itself.

  `src/ollama/vram.ts` derives the KV cost per token from what `/api/show`
  publishes and picks the largest window on a familiar ladder that still leaves a
  margin free. The dialog shows the arithmetic, so the number can be checked
  rather than trusted.

- **`versus-localqwen.kvCacheType`** (`f16` | `q8_0` | `q4_0`), used only for that
  sizing. The extension host does not inherit `OLLAMA_KV_CACHE_TYPE` from the
  systemd unit that sets it on the server, so it has to be told. The default
  assumes `f16`, which overestimates the cost and therefore suggests a SMALLER
  window — wrong in the safe direction.

### Notes

- **Only full-attention layers pay for the cache.** qwen35 declares
  `full_attention_interval: 4` over 64 blocks, so 16 layers hold a KV cache and
  the window is four times cheaper than the textbook formula predicts. Missing
  this would make every suggestion far too small; a test pins the divisor.
- **Validated against the measurement, not against itself.** The formula gives
  2171 MiB of KV at 65536 tokens where llama.cpp reports 2176 — 0.2% out. And fed
  the real 4090 figures captured on 19/08 (24564 MiB total, 1846 MiB free at
  65536), it answers 49152: the window that card could actually hold. That card
  was replaced on 20/08 by a 32 GB one, so this is now the only way to reason
  about the hardware the extension is meant to support.
- **It refuses rather than guesses.** No suggestion without free VRAM from
  nvidia-smi, a loaded model to anchor on, and the attention shape from
  `/api/show`. A projection with no measured starting point is a guess, and the
  dialog falls back to its previous default.
- The anchor is only valid for the cache type currently loaded: changing
  `OLLAMA_KV_CACHE_TYPE` invalidates the free reading it was taken under, so the
  code does not project across cache types.
- What it does NOT do, deliberately: reimplement Ollama's own open `--fit-vram`
  request (ollama#12353) by loading and reloading to search for a fit. One
  measured anchor plus a derived slope is enough, and costs nothing.

## [0.10.2] - 2026-08-19

Standalone patch "painel de safeguards ao vivo", from Versus for Claude 0.16.5.
Display only — no gate and no engine behaviour changed.

### Fixed

- **The safeguard panel showed a frozen portrait.** `state.safeguards[].status`
  starts at `ok` and is only written when something calls `checkSafeguard`;
  `advance_phase` validates the safeguards to decide a veto but never records the
  outcome. So the sidebar and `get_phase_state` could report all-green about a
  safeguard that was vetoing the next transition at that very moment. Both now
  derive the status on read, via `validateSafeguard`.

  Measured here, on a project sitting in Phase 4 that advanced without a Phase 0
  score of 90: the stored field says `S0=ok`, and the live check says
  `S0=violated`. Enforcement was always real; only the display lagged.

### Notes

- The staleness in this build is narrower than the patch describes, and worth
  recording accurately: `record_test_outcome` already routes through
  `engine.checkSafeguard("S6")`, which writes the field as a side effect. So S6
  specifically was usually fresh when the model reported a test through the tool —
  verified end to end. What stayed stale is everything else (S0, S1, S5, S7) and
  S6 on any path that does not go through that tool.
- By design only S0 and S6 ever reach `violated`; S1/S5/S7 are warnings and
  S2/S3/S4 are behavioural and always `ok`. A mostly green panel is legitimate —
  the fix is that the two that can turn red now do so when they are red.
- In Phase 5 a cleared S6 reads `warning`, not `ok`: it carries the standing
  "implementation active" advisory. The test asserts the transition out of
  `violated` and that the veto is gone, rather than a state S6 never has there.

## [0.10.1] - 2026-08-19

### Added

- **R6, an emission budget: ~1200 tokens per tool call or message.** The chat host
  aborts any single request at 60 seconds of wall clock, and it does so
  mid-stream — two measured failures returned at 59.947 s and 59.998 s with the
  model still generating, against 48 requests in the same window that finished
  under 10 s. At the ~37 tokens/s this build sustains, minus ~6 s prefilling the
  new context, the hard ceiling is about 2000 output tokens. A turn that crosses it
  dies as "Sorry, no response was returned", and retrying reproduces it exactly,
  because the size is the cause.

  The rule states the one fact that makes the fix cheap: **the deadline is per
  REQUEST, not per turn.** An agent turn is many requests and each restarts the
  clock, so splitting an emission costs nothing but a split. Long artifacts are
  appended across calls (~30 findings rows each); long tables are displayed in
  blocks with the range announced.

  R6 is always active, so it lands in part 1 of every phase — the part that always
  arrives inline. A rule the model never reads cannot prevent anything.

- Phase 2 says it where it happens: twelve lenses over every module passes 40
  findings easily, and 40 rows in one emission is over the cap.

### Notes

- **R6 does not weaken R5.** The complete table is still mandatory — complete in
  blocks, never summarized, never truncated, never "the rest is in the file". A
  test asserts both halves, because a budget read as permission to abbreviate would
  cost more than the timeout does.
- **Not a methodology change, and not a cross-build patch.** The ceiling is a
  function of tokens/s, a property of this runtime: a hosted model emits 2000
  tokens in seconds and never meets the deadline. This is the same kind of
  local-model adaptation as everything under `src/ollama/`. Earlier in this session
  I framed it as needing a four-build patch; that reading was wrong.
- Nothing else was available: there is no timeout setting (the only `chat.*`
  timeouts are terminal-tool ones), speculative decoding is already on (MTP,
  `--spec-type draft-mtp`), and the window cannot grow — 1.8 GB of VRAM headroom.

## [0.10.0] - 2026-08-19

Minor bump: `get_phase_guidance` gained a parameter and now answers in parts.

### Fixed

- **The phase guidance never reached the model on this host.** The chat host keeps
  a tool result inline only up to a limit it does not publish; measured on this
  build, 5691 chars arrived inline and 8377 was written out to
  `chat-session-resources/.../content.json` instead. Every phase's guidance is
  larger than that — the smallest is 8.1 KB, Phase 2 is 21 KB — so **all 11
  guidance calls in the RestaUm session were externalized, and no other tool ever
  was**. The model only got the rules if it noticed the file and went to fetch it;
  it was last seen trying to print the file back into the conversation in 1500-char
  chunks with python, which would have produced another oversized result and
  spilled again.

  `get_phase_guidance(phase, part)` now delivers the phase in order, in parts of
  at most 4 KB. Measured through the bundled server, the largest result is now
  4688 bytes — inside the confirmed-inline range, with 3689 bytes of margin.

### Changed

- Parts break on markdown headings and bold sub-block openers, never on a byte
  count, so a part never begins mid-sentence and a table keeps its header row. In
  Phase 2 the conditional-lens table splits exactly at the Domain Transfer Lenses
  block, which has a header of its own.
- Reading order is preserved exactly. Front-loading the exit gate was considered
  and rejected: it would change what the model does, not just when it reads it.
- Every part but the last carries `_nextAction` demanding the next call — the same
  mechanism `advance_phase` uses to chain.

### Notes

- The trade is stated rather than hidden: a phase can now be read halfway, which
  the monolithic shape made impossible. That replaces a worse failure — a phase
  whose rules never arrived at all, silently. The `_nextAction` chain is what
  closes it, and a test asserts the chain is unbroken on every part but the last.
- The invariant under test is that splitting is a delivery change, not an edit:
  the parts of every phase rejoin to exactly the original text.
- Cost: 34 calls to read all eight phases instead of 8. Each extra round trip is
  ~1 s of cached prefill (measured: 1646 tokens in 866 ms); the total guidance
  tokens in context are unchanged.
- **This diverges from the sibling builds on purpose.** Claude, Qwen and Kimi run
  on hosts with different limits and do not show the symptom. Nothing in IACDM says
  the guidance must arrive in one tool result — this is interface, not
  methodology — so no cross-build patch is warranted.
- The 4 KB budget also leaves room for the ~4.4 KB of global rules repeated in
  every phase's payload. Serving those once and referencing them later would save
  ~35 KB across a cycle, but was deliberately NOT done here: if a compaction drops
  the preamble it never comes back, and that would lose something real.

## [0.9.3] - 2026-08-19

### Fixed

- **The module cross-gate lost a module whenever the row above it named a
  dependency.** `tableColumn2` ran one global regex over the whole file, and a row
  whose last cell is itself an id — `depends-on` holding `M-01` — matched
  `| M-01 |` plus the newline plus the pipe that OPENS the next row, consuming it.
  That row was then never recognised, so its module vanished from the architecture
  set while its neighbours resolved normally.

  Found in the RestaUm project: an architecture declaring `board`, `ui` and `game`
  produced `{board, ui}`, and `game` was reported as absent from every version.
  The selectivity is what made it unfalsifiable from outside — editing the file
  could not fix it, because the file was already correct, and the message was true
  from the parser's point of view.

  Both `tableColumn2` and `countArtifactRows` now match per line, anchored. A
  table row cannot span lines, so nothing legitimate is lost and no match can walk
  across a newline.

### Notes

- Verified against the real project: the architecture now renders
  `{board, ui, game}` and the gate reports no drift.
- The bug came in with the v0.13.0 cross-gate, whose spec supplied this regex
  verbatim — so the same shape is likely present in the sibling builds. Worth a
  patch note to the batch: any project whose `depends-on` column names module ids
  can lose the module declared on the following row.

## [0.9.2] - 2026-08-19

### Fixed

- **"Align now" could not run at all.** It piped the modelfile to
  `ollama create <model> -f -`, and Ollama stopped reading standard input: 0.32.14
  answers `Error: no Modelfile or safetensors files found` and exits 1. The
  refusal was reported honestly, so nothing was silently wrong — the command was
  simply inert. It now writes the modelfile to a temp file and passes its path.

- **Aligning no longer re-imports the weights.** The old path patched the output
  of `ollama show --modelfile`, which names the weight blobs by absolute path;
  building from that makes Ollama import ~17 GB to change one number, and it was
  still running after three minutes when measured. `alignmentModelfile` now
  derives `FROM <tag>` instead, which completes in ~0.2 s — 144 ms for the whole
  `alignModelContext` call, measured against a throwaway tag.

  Deriving also preserves more, and more reliably: the template, renderer, parser,
  license, the second `FROM` that carries the draft model for speculative
  decoding, and every hand-set parameter are inherited by Ollama itself rather
  than by our line-editing. A later `PARAMETER` overrides an inherited one, so
  re-pinning a tag that already had a `num_ctx` replaces it.

- `withNumCtx` is gone with the approach it served; `alignmentModelfile` replaces
  it, and the tests moved with it.

### Notes

- Verified against a probe tag built from `qwen3.8:27b` and removed afterwards —
  the user's tag was never rewritten. The probe inherited all 8 parameters and
  came back with `num_ctx 65536` pinned.
- The rewrite is self-referential (`FROM <tag>` while replacing `<tag>`), which is
  the case worth doubting. Tested explicitly on the probe: it resolves the source
  manifest before writing the new one, and the parameters survive.

## [0.9.1] - 2026-08-09

Applies `APLICAR-CLASSIFICACAO-DE-TESTE-AGNOSTICA-NOS-OUTROS-BUILDS.md`, from
Versus for Claude 0.16.3. It corrects I.4 (0.9.0), which rested on a false
assumption about the harness payload.

### Added

- **`record_test_outcome` takes `exit_code`, and it outranks everything else.**
  The guidance now teaches the exit status as the standard invocation —
  `npm test; echo "VERSUS_TEST_EXIT=$?"` — and the number is reported back. `$?`
  comes from the shell, so 0 means green and anything else red in any language and
  any output format, which reading the output does not. Precedence: `exit_code` →
  `outcome` → the legacy `failed` → `unknown`.
- **`provenance.exitSource`** (`"harness" | "echo"`), so a relayed number is
  distinguishable from one a harness captured.

### Changed

- **`verifiedBy.nominal` for `test-pass` now means an exit status decided it and
  was 0**, from either source; `path` becomes `test-pass/exit-echo`. A verdict read
  off the output is the degraded path, because reading depends on the output's
  language and the exit status does not. Before this, `nominal` could never be true
  on this build at all.
- **The `tests_passing` refusal teaches the echo form.** The first `unknown` or
  failure corrects the habit, and because an inconclusive run does not freeze
  (0.9.0, I.1), the re-run is the one that counts.
- **Phase 6 guidance: never modify the test runner to make its output easier to
  classify.** Appending the echo costs one clause; editing the runner changes the
  thing under test to please the instrument.

### Notes

- **Scope here is smaller than the spec's, and for a reason it states.** The patch
  is a hook patch, and this build has no hook — it runs in VS Code chat, not a CLI,
  so there is no `PostToolUse` payload and no `detectExitCode` to add. What lands is
  the language-agnostic half: the number reaches the engine through the tool
  instead of through a hook reading stdout.
- **Verified against real records, as the patch insists.** Across the live
  `state.json` files under `INDT/`: every `lastTestOutcome` written by a
  hook-carrying sibling has `source: "harness"` with `toolUseId`, `sessionId`,
  `outputBytes`, `outputSha256` — and **no `exitCode`**. I.4 was indeed inert.
  Sharper still, one of those records (`Enduro`) has as its `command` a heredoc that
  **edited the test runner to print English markers**, with a comment saying the
  hook classifies output by English markers. The antipattern this patch forbids was
  already happening in the corpus.
- `nominal: true` here means an exit status decided the verdict, not that this host
  observed it: without a hook the number is relayed by the model. `exitSource:
  "echo"` and the provenance note say so, so the weaker link stays readable rather
  than hiding behind a true flag.

## [0.9.0] - 2026-08-09

Applies `APLICAR-POS-LOTE-COMPLETO-v0.15-a-v0.16.2-NOS-OUTROS-BUILDS.md`, Parts I
to VI, from Versus for Claude v0.15.0–v0.16.2. Minor bump: `record_test_outcome`
changed shape, two new gates on 6→7, and the lens triggers the guidance renders.

### Added

- **`unknown` is a real test outcome (I.1).** `recordTestOutcome(command, outcome,
  provenance?)` takes `"pass" | "fail" | "unknown"`. An inconclusive run is
  RECORDED — so a stale `fail` cannot stay frozen as the last thing anyone knew —
  and then does nothing else: it satisfies no gate and does not feed S6. Counting
  it as a failure would punish an unreadable output; ignoring it would leave the
  wrong verdict standing.
- **`lastTestOutcome` in `get_phase_state` (I.2).** One line, and it removes the
  reason a model had to open `state.json` by hand to see why the gate refused.
- **The `tests_passing` refusal quotes the record (I.3).** It now says whether
  nothing was recorded for this phase at all, or the last run failed, or could not
  be classified — with command, time and exit code when known. Those call for
  opposite next moves and used to read identically.
- **`verifiedBy` on the two `verify:` criteria (II).** Written by the engine after
  the gates pass and before the transition commits, via
  `stampVerificationProvenance(phase)`. `nominal: false` marks a degraded path.
  No new criterion — the two that exist gained provenance.
- **Cross gate 6→7: every 🔴 answered (III.1).** Each critical in the matrix must
  be referenced in `specs/validation/critical-coverage.md`, by a test or a stated
  reason. Skipped entirely when the matrix has no 🔴.
- **Conditional gate 6→7: numbered premises answered (III.2).** Engages only where
  `architecture.md` numbers its premises (`A-1`, `P-A8`); each id must appear in
  `specs/validation/premise-coverage.md`. Where premises are prose there is no id
  and nothing is demanded — about half the corpus writes them that way, and a gate
  cannot impose a convention that was never agreed.

### Changed

- **Nine conditional-lens triggers rewritten (V).** Each now states the condition
  its own central question implies, with the examples demoted to illustration:
  RES, MIG, ETI, PRO, OBS, CTR, JOG, LIN, MEC. SUS, UI/UX and GOV already had the
  form from 0.7.3 and were not touched. The warrant is measured: the narrow
  phrasing induced a reading error, and the finding was that the FORM does not
  generalise while the CONTENT does.
- **Phase 6 guidance (III.3, IV).** Asks for the two coverage files; recommends
  mutation-style detection checks (recommended, not gated — the tooling is not
  universal); measure per stage before optimizing; a micro-check is something you
  RUN, not something you read; when a test changes, say which scenario it builds,
  not just which assertion moved.
- **Phase 1 guidance (III.4).** Number the premises the design leans on, and give
  every `## V(N)` the COMPLETE module table rather than a delta — a delta reads
  identically to a design where the omitted modules are gone.

### Notes

- **Part I is partly out of scope here, by construction.** I.4 (classify by
  `exit_code`) and I.5 (hook provenance: `toolUseId`, `sessionId`, `outputSha256`)
  read a `PostToolUse` payload. This build has no hook — it runs in VS Code chat,
  not a CLI — so there is no exit code to observe. What landed instead: the tool
  stamps `provenance: { source: "mcp-tool", note: "…no hook observing an exit
  code" }`, and `verifiedBy.nominal` is therefore `false` for every `test-pass`
  here. That is the honest reading, and it is exactly the legible-contour goal of
  I.5: a reader can tell the model's word from an observed exit code. I.6 stays
  deferred as upstream left it.
- `record_test_outcome` keeps accepting the old `failed` boolean, so a caller
  written against the previous schema still works. With neither field the run is
  recorded as `unknown` rather than defaulting to a verdict.
- Part VI needs no code: `duplica` intra-lens stays a declared limitation (four
  judges marked 71/87/153/340 pairs, κ 0.110–0.338 — a gate would decide
  mechanically what four readers decide very differently); fixing the lens set
  across iterations stays rejected; the zero-occurrence forms stay declared.
- No batch project is discarded. This is instrument reinforcement plus a taxonomy
  correction for future work; the archived results (X, DOI 10.5281/zenodo.21908907)
  are not invalidated, and the activation numbers are Y measured against the
  archived corpus, not a new verdict on Phase 2.

## [0.8.2] - 2026-08-09

Standalone patch `APLICAR-GATE-DE-SEVERIDADE-NOS-OUTROS-BUILDS.md`, from Versus
for Claude 0.14.2. Same family as the lens-column gate: an instruction the
guidance gave and no gate enforced.

### Added

- **The `severity` column is checked on 2→3.** Exactly one of 🔴 / 🟡 / 🟢 per
  finding. Tolerant of decoration, strict about the signal: `🔴 Critical` passes,
  while `high`, `P1`, an empty cell and `🔴🟡` (ambiguous) block, naming the row
  and quoting the cell. The analysis counts criticals against important on this
  column, so a value it cannot count produces a wrong count rather than a missing
  one — the seventh discard waiting to happen.

  Runs inside the method that already walks the matrix findings, so it shares the
  `from === 2` path and the same error list.

### Notes

- Evidence this blocks nothing that exists, per the spec's instruction to scan
  first: across the 10 `coverage-matrix.md` files in this corpus, 853 findings use
  exactly three glyphs — 🟡 487, 🟢 217, 🔴 149, zero variation. Same distribution
  upstream reported.
- The finding parser now also reads the 4th cell; a row missing it yields an empty
  string, which blocks, as it should.
- Deliberately NOT gated, replicating upstream's decision: the description of a
  duplicate finding. The quality half ("describes the defect on its own") is the
  oracle and not mechanisable, and the mechanisable forms — a pointer-only
  description, a dangling `duplica:` — occur zero times in the corpus. A gate there
  would guard nothing and risk a false block. It stays a declared limitation of the
  protocol, not code.

## [0.8.1] - 2026-08-09

Standalone patch `APLICAR-FAXINA-v0.14.1-LENTES-FONTE-UNICA-E-MIGRACAO-PT-NOS-OUTROS-BUILDS.md`,
from Versus for Claude 0.14.1. **Non-behavioural**: the injected guidance is
byte-for-byte identical and no gate changed. Maintenance only.

### Changed

- **The lens definitions are a single source (Block A).** Each lens's central
  question, failure class and trigger lived as hand-written markdown inside the
  Phase 2 guidance — a second copy of names `lenses.ts` already owned, and exactly
  where a trigger edit could drift from what the gate validates. `LensDef` now
  holds the whole definition, the guidance renders its three tables from it, and
  `UNIVERSAL_LENSES` / `CONDITIONAL_LENSES` are derived rather than typed out
  again.

  This build splits the conditional lenses into two tables — 8 situational and 4
  Domain Transfer Lenses under their own heading — so the defs carry a `group`
  field and render as two tables, which is what keeps the output identical.

  The defs were extracted from the existing table programmatically rather than
  retyped, and the rendered guidance was diffed against the previous build: no
  difference, 68963 bytes either way.

### Removed

- **The Portuguese→English criterion id migration (Block B).** The shim renamed
  ids in `load()` for a `state.json` written before 0.3.6 and never reopened
  since. Removed from `engine.ts` (import, `load()` call, and the
  `migrateCriterionIds` method), `phases.ts` (the map), and `sidebar.ts` (the
  import and the doubled lookup predicate).

  Evidence for this build, per the spec's instruction not to remove blind: the
  scan over all 36 live `.versus/state.json` files under `INDT/` found 5 with
  Portuguese ids, all under `lixo/jogos/` — the same discardable set upstream
  found. Accepted consequence: a pre-rename project reopened after this shows its
  criteria as unmet.

### Notes

- No batch project needs discarding — this touches nothing the RO3 measures.

## [0.8.0] - 2026-08-09

Standalone patch `APLICAR-LENTES-ESTRUTURADAS-E-GATE-DE-LENTE-NOS-OUTROS-BUILDS.md`,
from Versus for Claude 0.14.0. Minor bump: a new MCP tool, a new state field, and
a Phase 2 gate that blocks what earlier builds allowed.

### Added

- **`src/rules/lenses.ts` — the 19 lenses as data.** `UNIVERSAL_LENSES` (7),
  `CONDITIONAL_LENSES` (12), `canonicalLens(raw)`. Case and the spacing around a
  slash are tolerated (`UI / UX` = `UI/UX`); translations, abbreviations and
  truncations are not, because each aggregates as a different lens rather than
  failing loudly.
- **`record_activated_lenses(conditional, notActivated)`.** Replaces the prose
  declaration. The schema enum admits only the 12 conditional names, and the
  handler refuses five ways: a non-canonical name, a universal lens passed as
  conditional (the conditional count is a measured variable), a lens listed as
  both activated and not, a duplicate, and a refusal with an empty reason. All 12
  must be accounted for. It answers with the `iteration` and `againstVersion` it
  recorded and the matrix heading to use.
- **`state.activatedLenses` — one `LensActivation` per round, in an array.**
  Fields: `universal`, `conditional`, `notActivated` (`[{lens, reason}]`),
  `iteration`, `againstVersion`, `recordedAt`. Re-recording the same round
  replaces it (a correction); a new round pushes, because that history is what
  lets a finding be checked against the set in force when it was raised.
- **`state.stateVersion` (1), stamped by `init_project`.** Its ABSENCE is what
  marks a legacy project, and the prose declaration is accepted only there.
  Without the stamp the fallback would be an opt-out in every new project.
- **The lens column is gated on 2→3.** Minimum form: one of the 19 canonical
  names or the literal `NENHUMA`. Strong form: a conditional lens must have been
  declared for the round THAT FINDING sits under. Universals always pass. Where
  the round cannot be resolved — no heading, or no declaration for that number —
  it degrades to the union of every declared set, permissive by design: a missed
  check is the acceptable failure here, a blocked legitimate project is not.

### Changed

- `activated_lenses_recorded` gained `verify: "lenses-recorded"`; it was the only
  Phase 2 criterion with no evidence behind its checkbox.
- Phase 2's guidance teaches the tool instead of the prose format, and states that
  the lens column is read on 2→3.

### Notes

- The round a declaration belongs to is derived from how many transitions entered
  Phase 2, floor 1 — the contract the analysis reads. This build also keeps
  `currentIteration` tracking the round (0.7.0) and lets `start_iteration(2)`
  raise it without a transition, so the higher of the two wins and the two
  mechanisms cannot disagree.
- Found while writing the tests: keying the resolved lens name by finding id let a
  duplicate id decide another row's verdict. Resolved per row now.
- Data consequence, carried from the spec: any slot run under the old behaviour
  that carries a non-canonical lens name should be discarded (upstream discarded
  T21, its second discard of the same slot).

## [0.7.4] - 2026-08-06

Standalone patch `APLICAR-RESET-SIMETRICO-DO-LACO-NOS-OUTROS-BUILDS.md`, from
Versus for Claude 0.13.1.

### Fixed

- **The loop back to Phase 2 now resets Phase 3's criteria as well.** 0.7.2 reset
  only Phase 2, so `criticals_addressed`, `important_decided`,
  `scope_preserved` and `architecture_simplified` survived the first pass. A
  project that looped — `2→3 · 3→2 · 2→3 · 3→4` — cleared the 3→4 gate with
  iteration 1's stamp, which answered iteration 1's findings. `criticals_addressed`
  from the first pass means nobody confirmed the second critique's criticals.

  The block is now the general form: a backward transition resets every phase from
  the target up to the one being left, which for 3→2 is phases 2 and 3. Phases
  outside the loop are untouched — verified on Phase 1 in the same run.

### Notes

- `start_iteration(2)` still resets Phase 2 only, and correctly so: it does not
  change phase, so Phase 3 was never redone. The spec confirms no third case
  exists — the real redo always goes through `advancePhase`, where the reset now
  lives.
- Data consequence for the batch, carried from the spec: any project already run
  that looped and passed 3→4 under the old behaviour holds an iteration 1 stamp on
  Phase 3. Whether to discard it is the batch's call (upstream discarded T21).

## [0.7.3] - 2026-08-06

Standalone patch `APLICAR-GATILHOS-E-GATE-CRUZADO-NOS-OUTROS-BUILDS.md`, from
Versus for Claude 0.13.0 (round R2). Two independent changes.

### Changed

- **Three conditional-lens triggers widened (Part A, guidance only).** Each was
  activating in 0/7 pilots because the trigger was narrower than the lens's own
  central question, or measured something else:
  - **UI/UX** — any surface a person operates, a CLI or operational tooling
    included, not only graphical end-user interfaces.
  - **Sustainability / Proportionality** — the system decides, allocates or
    consumes a resource whose cost grows with use; AI/ML and high-volume data are
    examples, not the test. Apply the central question, do not match examples.
  - **Governance / Accountability** — the system records or decides something
    someone will later have to audit, attribute or answer for. It is a SYSTEM
    property, so a single-operator project activates it when the system has it.

  Protocol note, recorded here for the trail: the Governance change alters the
  taxonomy the paper defends. The batch now measures the corrected taxonomy, not
  the published one.

### Added

- **Cross gate matrix × architecture, reinstated (Part B).** On 2→3, every module
  a finding row cites must appear in the module table of
  `specs/technical/architecture.md` — checked against the **union of all
  `## V(N)` versions**. A module removed between versions is tolerated, since the
  findings raised against it were raised while it existed; a name in no version
  at all is drift and blocks, naming the module. In the discarded batch 11
  findings pointed at modules that never existed, silently.

  This is the check removed in 0.7.1 at the batch's request, now coming back from
  upstream with union semantics — simpler than the per-round asymmetry 0.7.0 had,
  and it removes the need to know which version each round critiqued.

### Notes

- The gate skips when either artifact is absent or has no rows, so it cannot turn
  a missing-artifact case into a confusing drift message.
- Phase 2's guidance again states that the module column is checked, and against
  which versions — 0.7.1 had softened it to "nothing verifies the spelling",
  which would now be false.

## [0.7.2] - 2026-08-06

Standalone patch `APLICAR-RESET-COMPLETO-FASE2-NO-LOOP-NOS-OUTROS-BUILDS.md`,
from Versus for Claude 0.12.8.

### Fixed

- **Looping back to Phase 2 now clears all five exit criteria, not just the lens
  one.** Re-entry is a fresh critique of V(N+1): the matrix is re-produced and
  the criticals and concentration re-analysed. Resetting only
  `activated_lenses_recorded` left the other four marked from iteration 1, so the
  gate accepted the critique of V(1) as the critique of V(N+1), and the sidebar
  showed Phase 2 as "4/5 done" the moment the round began.

  Only the booleans reset; the artifacts stay on disk, which is what lets the new
  round append its `## Iteração N` section rather than start the file over. No
  criterion of any other phase is touched — verified on Phase 3 in the same run.

### Changed

- `start_iteration(2)` resets the same way, for the same reason: a new round
  within Phase 2 is a new critique, so it owes every criterion again. The spec
  covers only the loop-back, but leaving the two paths inconsistent would mean
  the same event cleared different things depending on how it was reached.

## [0.7.1] - 2026-08-06

Removes item 6 of `RO3/CORRECOES-EXTENSAO.md`, which the batch decided to keep
out of the extension. Items 1, 2, 3, 4, 5 and 7 are unchanged.

### Removed

- **The cross gate `matrix.module ⊆ architecture.modules`.** A finding may again
  name any module; whether that name is traceable is checked by the downstream
  analysis, against the architecture version of the round that raised it. Gone
  with it: `moduleTraceabilityEvidence` in the engine, and
  `parseArchitectureVersions` / `parseModuleTable` / `normalizeModule` from
  `state/artifacts.ts`, which nothing else used.

### Changed

- **What survives is the iteration heading.** `matrixRoundEvidence` still
  requires a `## Iteração N` section for the round in progress once the loop is
  past round 1 — that is item 5, not item 6, and its failure mode is different: a
  missing heading does not produce a wrong name, it collapses every finding in
  the file into iteration 1 with nothing reported.
- **Phase 2's guidance no longer promises a check that is not there.** It still
  says the `module` column takes a name from the architecture table, spelled the
  same way and taken from the version that round critiqued, but now says plainly
  that nothing verifies the spelling.

## [0.7.0] - 2026-08-06

Applies `RO3/CORRECOES-EXTENSAO.md` — the seven corrections the RO3 analysis
asked for, so the artifacts the batch reads can be dated, versioned and traced.
Minor bump rather than patch: `projectSpec` entries changed shape, and Phase 2
gained two gates that will block projects the previous build let through.

### Added

- **Per-round lens declaration (item 1).** Re-entering Phase 2 clears
  `activated_lenses_recorded`, and the gate now looks for a `record_decision`
  (phase 2, category `architecture`) carrying the lens marker and *this* round's
  number. One accumulated declaration cannot say which set was in force when a
  given finding was raised — the union of every round always contains the lens,
  which erases exactly the signal the correction creates.
- **The declaration names its architecture version (item 2).** `V(N)` is
  required in the same line. Without it the version has to be inferred from
  timestamps, which is where "estimated against V(1) or V(final)?" comes from.
- **Timestamps on `projectSpec` entries (item 4).** `stack`, `outOfScope`,
  `patterns` and `constraints` now hold `{ value, phase, at }`. Bare strings from
  older projects are still read, and merging keeps the FIRST stamp for a value —
  re-adding an entry does not make it newer, since the question the stamp answers
  is when the project first knew this. This is what lets an external estimator
  include only the entries provably earlier than the critique instead of dropping
  the spec whole.
- **Cross gate `matrix.module ⊆ architecture.modules` (item 6).** Deliberately
  asymmetric across rounds: the round in progress answers to the current
  `## V(N)`, earlier rounds to any version on record. A module dropped between
  V(1) and V(2) is the normal case, and iteration 1's findings still name it
  legitimately — a naive check here would block every project whose architecture
  actually changed, which upstream hit with `quota-limiter` in T13.

### Changed

- **The iteration counter now belongs to the 2↔3 loop.** It was reset to 1 on
  every transition, so every round read as iteration 1 — the same as having no
  counter. `3→2` increments it, `2→3` keeps it (Phase 3 writes the V(N+1) the
  next round critiques), everything else still resets.
- **Activation is by project signal only (item 3).** Phase 2's guidance now says
  that another lens appearing to cover the same failure class is not grounds to
  skip one, naming the T05 case (Mechanical Engineering skipped as redundant with
  Resilience). Lenses that overlap never running together makes the overlap
  unobservable by construction. The individual justification per non-activated
  lens stays mandatory — that text is the evidence.
- **The matrix carries a section heading per round (item 5).** `## Iteração N —
  V(N)`, appended above the previous rounds, never a new column: a column before
  the id would break the row gate, the frozen finding format, and every fixture
  written against them.
- **`duplica` applies within a single lens too (item 7).** One lens raising the
  same defect under two ids inflates its own exclusive contribution while the
  taxonomy has nothing to do with it (T13: `SCI-01 + SCI-06`, `LNG-01 + LNG-02`).

### Notes

- Item 5 was specified as guidance only. It is also gated, but only from round 2
  on: past round 1 a missing heading silently collapses every finding into
  iteration 1, and a wrong answer nobody reports is worse than a block. In round
  1 the default is already right, so an absent heading costs nothing.
- The iteration and lens-declaration tokens are matched by a Portuguese-first
  regex downstream (`itera[cç][aã]o\s*(\d+)`), so the guidance asks for
  `Iteração N` and `LENTES ATIVADAS` literally even though it is otherwise in
  English. The engine also accepts `iteration N` / `ACTIVATED LENSES`, since a
  build that only fails downstream fails silently.
- Verified through the bundled MCP server, not only the engine: a full 2↔3 round
  trip where Phase 3 drops a module, round 2 is blocked for naming it, and round
  1's finding against the same module stays valid.

## [0.6.3] - 2026-08-05

Standalone patch `APLICAR-ARQUITETURA-POR-VERSAO-NOS-OUTROS-BUILDS.md`, from
Versus for Claude 0.12.5. Guidance only — no code, no gate, no test changed.

### Changed

- **Phase 3 now appends `## V(N+1)` to the architecture doc instead of
  overwriting it.** The Phase 2↔3 loop critiques a different architecture every
  round, so a finding from iteration 1 can name a module that V(2) removed.
  Overwriting the table erases the only artifact where that module was ever
  named, and the per-module traceability the coverage matrix exists to give
  breaks precisely where the design moved most. Upstream saw this happen in the
  T01 pilot (`quota-limiter`). Every version is kept; the last section is the
  current one.

### Notes

- The spec says its block carries no backticks to escape; it carries two pairs
  (`## V(N+1)` and the file path), escaped here as the surrounding template
  literal requires. Verified in the rendered guidance, not just the source.
- The Phase 1 row gate is unaffected: it counts `M-` rows across the whole file,
  so extra version sections only add to the count.

## [0.6.2] - 2026-08-05

Standalone patch `APLICAR-FIX-ECO-DE-MODULO-NA-MATRIZ-NOS-OUTROS-BUILDS.md`, from
Versus for Claude 0.12.4. Found by the Kimi build.

### Fixed

- **The coverage-matrix gate accepted module rows as findings.** The architecture
  patch (0.6.0) made Phase 1 write `M-01` module ids, and the matrix pattern
  `[A-Za-z]{1,4}-\d+` matches `M-01` because `M` fits `{1,4}`. So a
  `coverage-matrix.md` that was nothing but an echo of the module table — zero
  findings — satisfied the Phase 2 gate: with `count: 1`, one `| M-01 | … |` line
  at the top was enough. A matrix with no findings is the one thing RO3 cannot
  have. The pattern now carries a negative lookahead, `(?!M-)`, so literal `M-`
  rows do not count.

  Verified against the bundled server: a matrix that is the module table verbatim
  blocks `advance_phase(3)`, and a real `| MEC-01 | gearbox | Mechanical
  Engineering | … |` row advances.

### Changed

- **Phase 2's guidance now reserves the prefix.** The lookahead alone has a trap:
  Mechanical Engineering is one of the 19 lenses, and a model that picked `M-` for
  it would have its findings silently dropped from the count — and be
  indistinguishable from modules in the RO3 parser. The guidance states the id
  prefix should be consistent per lens, that `M-` is reserved for modules, and
  that the Mechanical Engineering lens uses `MEC-`.

  The spec assumed a "use a consistent prefix per lens" paragraph already existed
  to append to; this build had none, so both the prefix rule and the reservation
  were added to the Phase 2 findings-table block.

### Notes

- Honest limit, carried from the spec: the lookahead closes the *literal* `M-`
  echo, which is the realistic failure (the model copies the architecture table
  verbatim). An echo relabelled `MOD-01`, or lowercased to `m-01`, would still
  pass. The gate checks form, not semantics; the prefix reservation is what closes
  the real vector.

## [0.6.1] - 2026-08-05

Standalone patch `APLICAR-FIX-EXEMPLO-POR-ARTEFATO-NOS-OUTROS-BUILDS.md`, from
Versus for Claude 0.12.3.

### Changed

- **Converged the gate message and the row examples with upstream.** The bug this
  patch fixes — one hardcoded example serving every `artifactRows` criterion, so a
  missing *module table* was answered with a *findings row* — was already fixed
  here in 0.6.0, found independently while applying the architecture patch. The
  spec credits the Kimi build with finding the same thing during its port.

  Since the fix was already in place, this release converges the wording and the
  two example strings on upstream's, so the four builds say the same thing.

### Notes

One deliberate divergence: `artifactRows.example` stays **required** here, where
upstream makes it optional. An omitted example is exactly how the bug arose, and
an optional field lets a future criterion add `artifactRows` and silently produce
a message with no example at all. The compiler catching it costs nothing; noticing
it in a block message months later costs a session.

Verified in both directions, which is what the patch asks for: a prose
`architecture.md` blocks with `M-01 | rate-limiter` and never `P-01 | auth`, and
an id-less grid blocks with `P-01 | auth` and never `M-01`.

## [0.6.0] - 2026-08-05

Standalone patch `APLICAR-ARQUITETURA-TABELA-MODULOS-NOS-OUTROS-BUILDS.md`, from
Versus for Claude 0.12.2. Its Arquivo 2 (the engine machinery) was already in
place from the matrix patch, so only 1, 3 and 4 applied.

### Changed

- **`specs/technical/architecture.md` must contain a module table.** Prose
  clears any size floor and leaves the module list unreadable to anything but a
  human, so `advance_phase` from Phase 1 now requires at least one row matching
  `M-\d+`:

  ```
  | id   | module      | responsibility        | interface                      | depends-on |
  | M-01 | rate-limiter| enforce per-key quota | allow(key) -> {ok, retryAfter} | store      |
  ```

  The id exists only to make the row recognisable. **The stable key across
  phases is the module name in column 2** — Phase 2's matrix and Phase 5 must
  reuse those names, since `rate-limiter` here and `quota` there is two artifacts
  that cannot be joined.

- **The block message now comes from the criterion, not from the code.** Two
  criteria share `artifactRows` with different tokens, so the previously
  hardcoded message would have told someone missing a *module table* to write a
  *findings row*. `artifactRows` gained an `example` field and the message quotes
  it. A test asserts each criterion produces its own example and not the other's.

### Notes

The patch names a limit worth repeating rather than burying: the gate checks that
a module table exists, **not** that Phase 2 and Phase 5 actually reused the
names. Drift from `rate-limiter` to `quota` becomes *detectable* — both artifacts
are machine-readable and diffable — but is not *prevented*. No gate cross-checks
`matrix.module ∈ architecture.modules`. That is a further step, not this one.

## [0.5.3] - 2026-08-05

Third revision of the same standalone patch
(`APLICAR-MATRIZ-ACHADOS-NOS-OUTROS-BUILDS.md`), which changed again after 0.5.2.

### Changed

- **The row floor drops from 3 to 1.** The gate only has to reject the shape that
  cannot be analysed — an id-less severity grid, which yields zero finding rows.
  Demanding three findings would make the tool require a quantity of findings,
  and in a study whose metric *is* finding count that is the instrument
  manufacturing its own result. Verified: the grid still blocks at `count: 1`,
  and a single finding row passes.

- **The `lens` column takes the canonical English lens name**, spelled as the
  guidance spells it — `Security`, not "Segurança" or "SEG". It is the join key:
  matrices from different projects only aggregate if every one writes the lens
  the same way.

- **Zero findings is stated as a red flag, not a pass.** Twelve lenses across
  every module producing nothing is AP1 — validation theater wearing the shape of
  success. The guidance now says to report it and re-run the lenses in generation
  mode rather than record an empty matrix.

- The block message names the two mistakes that actually cause "why is it still
  blocking?": an id without a hyphen (`P01`), and a row without pipes.

### Notes

Item 3 of the patch — replacing the Phase 2 offer of "zero findings → advance OR
skip to Phase 4" — does not apply here. That text is from the Claude line; this
build came from the Copilot line, whose exit gate always routed to Phase 3 and
explains that zero 🔴 is the criterion to *leave* the 2↔3 loop, not to skip it.
`isValidTransition` rejects 2→4 outright. Only the red-flag sentence was missing,
and it was added.

## [0.5.2] - 2026-08-05

### Fixed

- **The criterion description still asked for the grid the gate rejects.** 0.5.1
  changed the coverage matrix to a findings table and gated its structure, but
  left `coverage_matrix`'s description reading "Coverage matrix modules x lenses
  displayed in chat" — and that description is exactly what the model reads from
  `get_exit_criteria` and from the blocked-transition message. It was being told
  to produce the shape that gets it blocked.

  Two more places said the same thing: the R5 mandatory-display line for P2, and
  the "Coverage Matrix (mandatory)" heading in the Phase 2 guidance. All three now
  describe one row per finding.

  The Phase 2 heading also gained what the grid conveyed and a findings table can
  lose: every module × lens pair must still be accounted for, and a pair that
  produced nothing is a valid result recorded as such rather than omitted.

## [0.5.1] - 2026-08-05

Delta from Versus for Claude 0.12.0 (commit `5998fed`), on top of the 0.11.0
gates already in 0.5.0.

### Changed

- **The coverage matrix is a findings table, and the gate checks its shape.** A
  modules × lenses grid of severities clears any size floor and cannot be worked
  from: a cell holding 🔴 says a lens found something, not what. Phase 3 is
  supposed to address findings one at a time, and a grid gives it nothing to
  address.

  `specs/design/coverage-matrix.md` must now hold at least three rows in the
  form `id | module | lens | severity | description`, each finding carrying its
  own id, with overlap declared as `duplica: <id>` rather than merged away —
  telling overlap apart from orthogonality is the point of the matrix.

  New `artifactRows` on `ExitCriterionDef` and `countArtifactRows` on the engine
  express it. Form only: the engine does not judge whether a finding is real or
  whether a `duplica` is honest.

- Phase 3 guidance now addresses findings **by id**, records what each resolved
  to, and treats an unaccounted id as silent scope deferral (AP10).

### Notes

Verified against the three scenarios the spec asks for, through the MCP server:
no file blocks naming the path; a 178-character severity grid clears the size
floor and blocks naming the finding-id format; a three-id findings table passes.

The middle scenario is the one worth having: the first grid I wrote for it was
under the 80-character floor, so it blocked with "missing or empty" and would
have looked like a pass of the structural check without ever reaching it.

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
