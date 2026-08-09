# Changelog

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
