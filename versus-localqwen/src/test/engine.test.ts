// State Engine and Methodology Rules tests

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { StateEngine, LOOP_FAILURE_THRESHOLD } from "../state/engine";
import { ScoreBreakdown } from "../state/types";
import {
  EMISSION_BUDGET_TOKENS,
  getCompleteGuidance,
  getFullGuidance,
  splitGuidance,
} from "../rules/full-guidance";
import { alignmentModelfile } from "../ollama/align";
import { DEFAULT_HEADROOM_MIB, fitWindow, kvMiBPerToken } from "../ollama/vram";
import { applyPatch, inspect, PATCH_MARKER, revertPatch } from "../ollama/estimator-patch";
import {
  advertisedBudget,
  assessAlignment,
  CALIBRATION_PROBE,
  compareToServer,
  DRIFT_THRESHOLD,
  effectiveBudget,
  estimateTokens,
  hasDrifted,
  ModelWindow,
  resolveBudgetFloor,
} from "../ollama/client";
import { handleGetPhaseGuidance } from "../mcp/tools/guidance-tools";
import { fitDecisions, handleGetPhaseState } from "../mcp/tools/state-tools";
import { handleRecordTestOutcome } from "../mcp/tools/loop-tools";
import { handleRecordActivatedLenses } from "../mcp/tools/lens-tools";
import {
  CONDITIONAL_LENSES,
  CONDITIONAL_LENS_DEFS,
  UNIVERSAL_LENSES,
  UNIVERSAL_LENS_DEFS,
  canonicalLens,
} from "../rules/lenses";

function createTempWorkspace(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "versus-test-"));
  // Create specs/ for checkSpecsStatus tests
  const specsDirs = ["references", "domain", "technical", "examples", "design", "models", "datasets", "validation", "competitors"];
  for (const dir of specsDirs) {
    fs.mkdirSync(path.join(tmp, "specs", dir), { recursive: true });
    fs.writeFileSync(path.join(tmp, "specs", dir, "README.md"), "# " + dir);
  }
  return tmp;
}

/** Phases that promise an artifact only advance once it exists on disk. */
function writeSpecArtifact(tmp: string, rel: string, body = "x".repeat(120)): void {
  const full = path.join(tmp, "specs", rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, "utf-8");
}

/**
 * The coverage matrix is gated on structure, not just presence: one row per
 * finding, each with its own id, so overlap can be told from orthogonality.
 */
const FINDINGS_TABLE = [
  "## Iteração 1 — V(1)",
  "",
  "| id | module | lens | severity | description |",
  "|----|--------|------|----------|-------------|",
  "| P-01 | rate-limiter | Security | 🔴 | the key reaches the log on a denied call |",
  "| P-02 | store | Assumptions | 🟡 | assumes the counter never wraps |",
  "| ARQ-3 | rate-limiter | Architectural | 🟢 | quota policy and transport are coupled |",
].join("\n");

/** Mechanical Engineering is a real lens; its prefix must survive the lookahead. */
const MECHANICAL_FINDING = [
  "| id | module | lens | severity | description |",
  "|----|--------|------|----------|-------------|",
  "| MEC-01 | store | Mechanical Engineering | 🔴 | no tolerance for a counter written out of order |",
].join("\n");

/** A grid of severities: same size, same lenses, no finding is identifiable. */
const SEVERITY_GRID = [
  "| module | Security | Assumptions | Architectural |",
  "|--------|----------|-------------|---------------|",
  "| auth | 🔴 | 🟡 | 🟢 |",
  "| store | 🟢 | 🔴 | 🟡 |",
  "| api | 🟡 | 🟢 | 🔴 |",
].join("\n");

function writeCoverageMatrix(tmp: string, body = FINDINGS_TABLE): void {
  writeSpecArtifact(tmp, "design/coverage-matrix.md", body);
}

/**
 * The architecture doc is gated the same way, on its own token: `M-\d+`. The
 * module name in column 2 is the key Phase 2 and Phase 5 are meant to reuse.
 */
const MODULE_TABLE = [
  "| id | module | responsibility | interface | depends-on |",
  "|------|-------------|----------------|-----------|------------|",
  "| M-01 | rate-limiter | enforce per-key quota | allow(key) -> {ok, retryAfter} | store |",
  "| M-02 | store | persist counters | get(key) / set(key, v) | — |",
].join("\n");

/** The same decomposition as prose: readable by a person, not by a machine. */
const PROSE_ARCHITECTURE =
  "The rate limiter enforces a per-key quota by asking the store for the current " +
  "counter and comparing it against the configured ceiling. The store persists " +
  "counters and exposes get and set. Neither module knows about transport.";

function writeArchitectureDoc(tmp: string, body = MODULE_TABLE): void {
  writeSpecArtifact(tmp, "technical/architecture.md", body);
}

/**
 * The Phase 1 module table, copied verbatim into the matrix. Realistic failure:
 * `M` fits `[A-Za-z]{1,4}`, so before the lookahead this echo counted as findings
 * and a matrix with zero findings passed the gate.
 */
const MODULE_ECHO = MODULE_TABLE;

function cleanTempWorkspace(tmp: string): void {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function makeFullBreakdown(total: number): ScoreBreakdown {
  // Distributes the score proportionally to the weights
  const factor = total / 100;
  return {
    clarezaProblema: Math.round(10 * factor),
    casosDeUso: Math.round(15 * factor),
    vocabulario: Math.round(10 * factor),
    ambiguidades: Math.round(15 * factor),
    foraDeEscopo: Math.round(10 * factor),
    criteriosSucesso: Math.round(10 * factor),
    premissas: Math.round(10 * factor),
    documentacao: Math.round(5 * factor),
    usuarioConfirmou: Math.round(10 * factor),
    iaConfiante: Math.round(5 * factor),
  };
}

// ===== Tests =====

let workspace: string;
let engine: StateEngine;

function setup() {
  workspace = createTempWorkspace();
  engine = new StateEngine(workspace);
}

function teardown() {
  cleanTempWorkspace(workspace);
}

function test(name: string, fn: () => void) {
  setup();
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err}`);
    process.exitCode = 1;
  } finally {
    teardown();
  }
}

console.log("\n=== State Engine Tests ===\n");

// --- Project ---

test("initProject creates state.json", () => {
  const state = engine.initProject("Test", "Desc");
  assert.strictEqual(state.projectName, "Test");
  assert.strictEqual(state.currentPhase, 0);
  assert.strictEqual(state.currentIteration, 1);
  assert.strictEqual(state.phase0Score, null);
  assert.strictEqual(state.decisions.length, 0);
  assert.strictEqual(state.safeguards.length, 8);

  // Verify persistence
  const statePath = path.join(workspace, ".versus", "state.json");
  assert.ok(fs.existsSync(statePath));
});

test("initProject rejects if already exists", () => {
  engine.initProject("Test", "Desc");
  const loaded = engine.getPhaseState();
  assert.ok(loaded !== null);
  // Second init should not overwrite (tested via MCP tool)
});

test("getPhaseState returns null without project", () => {
  const state = engine.getPhaseState();
  assert.strictEqual(state, null);
});

test("load recovers state from disk", () => {
  engine.initProject("Persist", "Test");
  const engine2 = new StateEngine(workspace);
  const state = engine2.getPhaseState();
  assert.ok(state !== null);
  assert.strictEqual(state!.projectName, "Persist");
});

// --- Decisions ---

test("recordDecision persists and is queryable", () => {
  engine.initProject("Test", "Desc");
  const d = engine.recordDecision(0, "scope", "Out of scope: i18n");
  assert.ok(d.id);
  assert.strictEqual(d.phase, 0);
  assert.strictEqual(d.category, "scope");

  const decisions = engine.getDecisions(0);
  assert.strictEqual(decisions.length, 1);
  assert.strictEqual(decisions[0].content, "Out of scope: i18n");
});

test("getDecisions filters by phase", () => {
  engine.initProject("Test", "Desc");
  engine.recordDecision(0, "scope", "D1");
  engine.recordDecision(1, "arch", "D2");
  engine.recordDecision(0, "req", "D3");

  assert.strictEqual(engine.getDecisions(0).length, 2);
  assert.strictEqual(engine.getDecisions(1).length, 1);
  assert.strictEqual(engine.getDecisions().length, 3);
});

// --- Score ---

test("updateScore saves and is queryable", () => {
  engine.initProject("Test", "Desc");
  engine.updateScore(85, makeFullBreakdown(85));

  const state = engine.getPhaseState()!;
  assert.strictEqual(state.phase0Score, 85);
  assert.ok(state.phase0Breakdown !== null);
});

// --- Exit Criteria ---

test("markExitCriterion creates and updates", () => {
  engine.initProject("Test", "Desc");
  engine.markExitCriterion(0, "score_90", true, "Score 92");

  const criteria = engine.getExitCriteriaState(0);
  assert.strictEqual(criteria.length, 1);
  assert.strictEqual(criteria[0].met, true);

  // Update existing
  engine.markExitCriterion(0, "score_90", false, "Re-evaluated");
  const updated = engine.getExitCriteriaState(0);
  assert.strictEqual(updated[0].met, false);
});

test("getExitCriteriaWithDefs shows defs and state", () => {
  engine.initProject("Test", "Desc");
  engine.markExitCriterion(0, "score_90", true);

  const criteria = engine.getExitCriteriaWithDefs(0);
  assert.ok(criteria.length > 0);
  const score = criteria.find((c) => c.criterion === "score_90");
  assert.ok(score);
  assert.strictEqual(score!.met, true);

  const other = criteria.find((c) => c.criterion === "user_confirmed");
  assert.ok(other);
  assert.strictEqual(other!.met, false);
});

// --- Transitions ---

test("advancePhase blocks without exit criteria", () => {
  engine.initProject("Test", "Desc");
  const result = engine.advancePhase(1);
  assert.strictEqual(result.ok, false);
  if (!result.ok) {
    // Naming a criterion, not just counting: a message-assembly path that throws
    // or interpolates undefined is invisible to a test that reads the boolean.
    assert.ok(result.error.missingCriteria.some((m) => m.includes("[Phase 0]")));
    assert.ok(result.error.missingCriteria.some((m) => m.includes("user_confirmed")));
  }
});

test("advancePhase blocks without score 90", () => {
  engine.initProject("Test", "Desc");
  engine.updateScore(75, makeFullBreakdown(75));
  // Mark all exit criteria
  const criteria = engine.getExitCriteriaWithDefs(0);
  for (const c of criteria) {
    engine.markExitCriterion(0, c.criterion, true);
  }
  const result = engine.advancePhase(1);
  assert.strictEqual(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.error.missingCriteria.some((m) => m.includes("score = 75") && m.includes(">= 90")),
      "the block must say the score it read and the one it wants"
    );
  }
});

test("advancePhase allows with score >= 90 and criteria", () => {
  engine.initProject("Test", "Desc");
  engine.updateScore(92, makeFullBreakdown(92));
  const criteria = engine.getExitCriteriaWithDefs(0);
  for (const c of criteria) {
    engine.markExitCriterion(0, c.criterion, true);
  }
  const result = engine.advancePhase(1);
  assert.strictEqual(result.ok, true);

  const state = engine.getPhaseState()!;
  assert.strictEqual(state.currentPhase, 1);
  assert.strictEqual(state.currentIteration, 1);
  assert.strictEqual(state.history.length, 1);
});

test("advancePhase blocks invalid transition (0→2)", () => {
  engine.initProject("Test", "Desc");
  const result = engine.advancePhase(2);
  assert.strictEqual(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.error.missingCriteria.some(
        (m) => m.includes("Phase 0 to Phase 2 is not allowed") && m.includes("loop 2↔3")
      ),
      "the block must name both ends and what is allowed instead"
    );
  }
});

test("loop Phase 2↔3 allowed", () => {
  engine.initProject("Test", "Desc");
  // Fast-forward to Phase 2
  engine.updateScore(95, makeFullBreakdown(95));
  for (const c of engine.getExitCriteriaWithDefs(0)) engine.markExitCriterion(0, c.criterion, true);
  engine.advancePhase(1);
  for (const c of engine.getExitCriteriaWithDefs(1)) engine.markExitCriterion(1, c.criterion, true);
  writeArchitectureDoc(workspace);
  engine.advancePhase(2);

  assert.strictEqual(engine.getPhaseState()!.currentPhase, 2);

  // Phase 2 → 3
  for (const c of engine.getExitCriteriaWithDefs(2)) engine.markExitCriterion(2, c.criterion, true);
  declareLenses(engine);
  writeCoverageMatrix(workspace);
  const to3 = engine.advancePhase(3);
  assert.strictEqual(to3.ok, true);

  // Phase 3 → 2 (loop)
  for (const c of engine.getExitCriteriaWithDefs(3)) engine.markExitCriterion(3, c.criterion, true);
  const to2 = engine.advancePhase(2);
  assert.strictEqual(to2.ok, true);
  assert.strictEqual(engine.getPhaseState()!.currentPhase, 2);
});

// --- Iterations ---

test("startIteration increments counter", () => {
  engine.initProject("Test", "Desc");
  assert.strictEqual(engine.getPhaseState()!.currentIteration, 1);

  const r = engine.startIteration(0);
  assert.strictEqual(r.ok, true);
  if (r.ok) {
    assert.strictEqual(r.value.iterationNumber, 2);
  }
  assert.strictEqual(engine.getPhaseState()!.currentIteration, 2);
});

test("startIteration rejects wrong phase", () => {
  engine.initProject("Test", "Desc");
  const r = engine.startIteration(1); // currently on phase 0
  assert.strictEqual(r.ok, false);
  if (!r.ok) assert.ok(r.error.includes("Current phase is 0, not 1"), "say which phase it is on");
});

// --- Safeguards ---

test("checkSafeguard S0 ok when on Phase 0", () => {
  engine.initProject("Test", "Desc");
  const r = engine.checkSafeguard("S0");
  assert.strictEqual(r.status, "ok");
});

test("checkAllSafeguards returns applicable", () => {
  engine.initProject("Test", "Desc");
  const results = engine.checkAllSafeguards();
  assert.ok(results.length > 0);
});

// --- Specs ---

test("checkSpecsStatus detects empty and populated dirs", () => {
  engine.initProject("Test", "Desc");

  // All empty (only README.md)
  let status = engine.checkSpecsStatus();
  assert.strictEqual(status["domain"].populated, false);

  // Populate domain/
  fs.writeFileSync(path.join(workspace, "specs", "domain", "glossario.md"), "# Glossary");
  status = engine.checkSpecsStatus();
  assert.strictEqual(status["domain"].populated, true);
  assert.strictEqual(status["domain"].fileCount, 1);
});

// --- Complete Guidance Presence Tests ---
// Inject-context now injects the COMPLETE methodology guidance every turn
// (instead of a curated compact summary). These tests guard against accidental
// removal of critical methodology terms from full-guidance.ts.

console.log("\n=== Complete Guidance Presence Tests ===\n");

const completeGuidanceText = getCompleteGuidance();

function assertPresent(term: string, reason: string) {
  assert.ok(
    completeGuidanceText.includes(term),
    `Complete guidance missing "${term}" — ${reason}`
  );
}

test("global rules + antipatterns present", () => {
  assertPresent("R2:",  "R2 (AskUserQuestion) is a core rule");
  assertPresent("R5:",  "R5 (Mandatory Display) is a core rule");
  assertPresent("AP1",  "AP1 (Validation theater) defines generation mode");
  assertPresent("AP10", "AP10 (Silent scope deferral) is the latest antipattern");
});

test("P0 critical terms present", () => {
  assertPresent("HIERARCHICAL SEMANTIC ANALYSIS", "P0 core method");
  assertPresent("Delivery Target", "P0 mandatory first question");
  assertPresent("Production Capacity Check", "P0 capacity check (added v0.6.1)");
  assertPresent("Tier 1", "P0 feasibility tier");
});

test("P1 critical terms present", () => {
  assertPresent("UI module", "UI must be explicit module in P1 decomposition");
  assertPresent("update_project_spec", "P1 must persist structured spec");
});

test("P2 critical terms present", () => {
  for (const lens of ["Assumptions", "Architectural", "Implementability", "Scientific", "Security", "Performance", "Regulatory"]) {
    assertPresent(lens, `universal lens "${lens}" must be named`);
  }
});

test("P5 critical terms present", () => {
  assertPresent("adversarial micro-check", "S7 per-module divergence check");
  assertPresent("Original Scope Adversarial Review", "AP10 prevention via explicit scope review");
  assertPresent("Renegotiate scope", "user option to renegotiate scope");
  assertPresent("ACCEPTED GAPS", "user option to accept gaps as documented debt");
  assertPresent("ui_runnable", "P5 exit criterion");
});

test("P6 critical terms present", () => {
  assertPresent("Session Renewal", "P6 Step 0 session renewal");
  assertPresent("Playwright", "primary UI tool recommendation for web SPA");
  assertPresent("Detox", "primary UI tool recommendation for React Native");
});

test("P7 critical terms present", () => {
  assertPresent("start_new_cycle", "meta-iteration tool");
  assertPresent("init_project", "prohibition against init_project for v2 must be present");
});

test("LLM switch + retomar Versus terms present", () => {
  assertPresent("LLM Switch Point", "P4→P5 model switch notification");
  assertPresent("retomar Versus", "anchor phrase for context recovery");
});

console.log("\n=== Context Budget Guard Tests ===\n");

function numCtxCount(modelfile: string): number {
  return (modelfile.match(/^PARAMETER num_ctx /gm) ?? []).length;
}

test("the alignment modelfile derives from the tag, so nothing is re-imported", () => {
  const out = alignmentModelfile("qwen3.8:27b", 65536);
  // FROM the tag, not the weight blob paths that `ollama show --modelfile`
  // prints: building from those makes Ollama re-import ~17 GB to change one
  // number, and it took minutes when measured.
  assert.ok(out.includes("FROM qwen3.8:27b"));
  assert.ok(!out.includes("/blobs/"), "a blob path here means a full re-import");
  assert.strictEqual(numCtxCount(out), 1);
});

test("re-pinning overrides the inherited value rather than duplicating it", () => {
  // Ollama resolves a later PARAMETER over the inherited one, so the file stays
  // two lines however many times a tag has been aligned before.
  const out = alignmentModelfile("already-pinned:tag", 32768);
  assert.strictEqual(numCtxCount(out), 1);
  assert.ok(out.trim().split("\n").length === 2, "one FROM, one PARAMETER");
});

test("advertisedBudget follows the Ollama provider precedence", () => {
  // Pinned num_ctx wins over the architectural maximum.
  const pinned: ModelWindow = { loadedWindow: 65536, pinnedNumCtx: 65536, architecturalMax: 262144 };
  assert.strictEqual(advertisedBudget(pinned).input, 65536 - 4096);
  assert.strictEqual(advertisedBudget(pinned).source, "num_ctx parameter");

  // Without a pin the provider falls through to model_info context_length.
  const unpinned: ModelWindow = { loadedWindow: null, pinnedNumCtx: null, architecturalMax: 262144 };
  assert.strictEqual(advertisedBudget(unpinned).input, 262144 - 4096);

  // With neither, the provider's own 32768 fallback applies.
  const bare: ModelWindow = { loadedWindow: null, pinnedNumCtx: null, architecturalMax: null };
  assert.strictEqual(advertisedBudget(bare).input, 32768 - 4096);
});

test("assessAlignment separates proven overflow from an unpinned window", () => {
  const aligned: ModelWindow = { loadedWindow: 65536, pinnedNumCtx: 65536, architecturalMax: 262144 };
  assert.strictEqual(assessAlignment(aligned).state, "aligned");

  // The regression this whole guard exists for: host budgets 258048 against a
  // 65536 runtime window, so prompts are clipped instead of rejected.
  const misaligned: ModelWindow = { loadedWindow: 65536, pinnedNumCtx: null, architecturalMax: 262144 };
  const verdict = assessAlignment(misaligned);
  assert.strictEqual(verdict.state, "misaligned");
  assert.strictEqual(verdict.advertisedInput, 258048);
  assert.ok(verdict.factor !== null && verdict.factor > 3.9);

  // Unloaded and unpinned is a warning, not silence.
  const unloaded: ModelWindow = { loadedWindow: null, pinnedNumCtx: null, architecturalMax: 262144 };
  assert.strictEqual(assessAlignment(unloaded).state, "unpinned");
});

test("estimateTokens errs high against the measured ratio", () => {
  // 57473 chars of Versus guidance tokenized to 13861 on qwen3.6 (4.15 ch/tok).
  const estimated = estimateTokens(57473);
  assert.ok(estimated >= 13861, `estimate ${estimated} must not undercount the measured 13861`);
  assert.ok(estimated < 13861 * 1.1, "estimate must stay within 10% of measured");
});

test("compareToServer flags the compaction-loop case as under-use", () => {
  // The regression seen in practice: server loaded 65536, host still holding
  // limits from before the model changed, so it compacts around 28k.
  const under = compareToServer({ maxInputTokens: 28672 }, 65536);
  assert.strictEqual(under.kind, "under");
  if (under.kind === "under") {
    assert.strictEqual(under.wastedTokens, 65536 - 28672);
  }

  // Clipping risk is the opposite direction and must stay distinguishable.
  const over = compareToServer({ maxInputTokens: 258048 }, 65536);
  assert.strictEqual(over.kind, "over");

  // The provider's own output reserve must not read as a fault.
  assert.strictEqual(compareToServer({ maxInputTokens: 61440 }, 65536).kind, "ok");

  // Nothing to compare without both numbers.
  assert.strictEqual(compareToServer(undefined, 65536).kind, "unknown");
  assert.strictEqual(compareToServer({ maxInputTokens: 61440 }, null).kind, "unknown");
});

test("phase 0 guidance is readable before init_project", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "versus-noinit-"));
  try {
    const engine = new StateEngine(tmp);
    // The bootstrap protocol tells the model how to call init_project, so
    // requiring an initialized project to read it would be circular.
    const ok = JSON.parse(handleGetPhaseGuidance(engine, { phase: 0 }));
    assert.strictEqual(ok.initialized, false);
    assert.strictEqual(ok.part, 1);

    // The bootstrap protocol is somewhere in the parts, not necessarily the first.
    let whole = "";
    for (let p = 1; p <= ok.totalParts; p++) {
      whole += JSON.parse(handleGetPhaseGuidance(engine, { phase: 0, part: p })).guidance;
    }
    assert.ok(whole.includes("BOOTSTRAP PROTOCOL"));
    assert.ok(whole.includes("SURFACE files only"));

    // Later phases stay gated — there is no state for them to describe.
    const denied = JSON.parse(handleGetPhaseGuidance(engine, { phase: 3 }));
    assert.ok(denied.error);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("drift detection tolerates a healthy estimator", () => {
  // Measured on qwen3.6: the probe is 355 chars and 81 real tokens (4.38
  // chars/token). The provider's untouched default of 4 is close enough that it
  // must not trip the detector.
  const trueTokens = 81;
  for (const ratio of [4.38, 4]) {
    const hostTokens = Math.ceil(CALIBRATION_PROBE.length / ratio);
    const reading = {
      hostTokens,
      trueTokens,
      factor: hostTokens / trueTokens,
      impliedCharsPerToken: CALIBRATION_PROBE.length / hostTokens,
    };
    assert.ok(!hasDrifted(reading), `ratio ${ratio} must not read as drift`);
  }
});

test("drift detection catches the collapsed ratio behind early compaction", () => {
  const trueTokens = 81;
  // Once the provider's ratio halves, a 61440 budget behaves like ~28k — the
  // range where sessions were observed compacting with the window mostly free.
  const hostTokens = Math.ceil(CALIBRATION_PROBE.length / 2);
  const reading = {
    hostTokens,
    trueTokens,
    factor: hostTokens / trueTokens,
    impliedCharsPerToken: CALIBRATION_PROBE.length / hostTokens,
  };
  assert.ok(hasDrifted(reading));
  assert.ok(reading.factor > DRIFT_THRESHOLD);

  const usable = effectiveBudget(61440, reading);
  assert.ok(usable > 25000 && usable < 30000, `usable budget was ${usable}`);

  // Worse ratios must degrade monotonically, never wrap or clamp.
  const worse = Math.ceil(CALIBRATION_PROBE.length / 1);
  const worseReading = {
    hostTokens: worse,
    trueTokens,
    factor: worse / trueTokens,
    impliedCharsPerToken: CALIBRATION_PROBE.length / worse,
  };
  assert.ok(effectiveBudget(61440, worseReading) < usable);
});

test("resolveBudgetFloor reads fractions and absolutes the way the setting documents", () => {
  // Below 1 is a fraction of what the host registered.
  assert.strictEqual(resolveBudgetFloor(0.66, 61440), 40550);
  // 100 and above is an absolute token count, independent of the model.
  assert.strictEqual(resolveBudgetFloor(40000, 61440), 40000);
  assert.strictEqual(resolveBudgetFloor(40000, undefined), 40000);
  // A fraction is meaningless without a budget to take it from.
  assert.strictEqual(resolveBudgetFloor(0.66, undefined), null);
  // Zero disables prompting entirely.
  assert.strictEqual(resolveBudgetFloor(0, 61440), null);
});

test("the measured 3.57x session falls below the default floor", () => {
  // The reading captured in a live session: probe of 355 chars, true cost 81
  // tokens, host counting 289. This must be what triggers the offer, while the
  // provider's healthy default must not.
  const budget = 61440;
  const floor = resolveBudgetFloor(0.66, budget)!;

  const drifted = { hostTokens: 289, trueTokens: 81, factor: 289 / 81, impliedCharsPerToken: 355 / 289 };
  assert.strictEqual(effectiveBudget(budget, drifted), 17220);
  assert.ok(effectiveBudget(budget, drifted) < floor);

  const healthy = { hostTokens: 89, trueTokens: 81, factor: 89 / 81, impliedCharsPerToken: 355 / 89 };
  assert.ok(effectiveBudget(budget, healthy) > floor, "the untouched default must not prompt");
});

console.log("\n=== S6 Loop Detection Tests ===\n");

function engineInPhase5(): { engine: StateEngine; tmp: string } {
  const tmp = createTempWorkspace();
  const engine = new StateEngine(tmp);
  engine.initProject("s6", "loop detection");
  const state = engine.getPhaseState()!;
  (state as any).currentPhase = 5;
  // Persist the forced phase through the engine's own save path.
  engine.recordDecision(5, "scope", "phase forced for test");
  return { engine, tmp };
}

test("only failures accumulate — a passing run clears the counter", () => {
  const { engine, tmp } = engineInPhase5();
  try {
    assert.strictEqual(engine.recordTestOutcome("pytest tests/", "fail").count, 1);
    assert.strictEqual(engine.recordTestOutcome("pytest tests/", "fail").count, 2);
    // The green run is the end of the work, never a loop. Counting it would make
    // S4 (execute and verify) impossible to satisfy.
    assert.strictEqual(engine.recordTestOutcome("pytest tests/", "pass").count, 0);
    assert.ok(!engine.isLoopBlocked());
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("three undiagnosed failures violate S6", () => {
  const { engine, tmp } = engineInPhase5();
  try {
    for (let i = 0; i < LOOP_FAILURE_THRESHOLD; i++) {
      engine.recordTestOutcome("pytest tests/test_tasks.py", "fail");
    }
    assert.ok(engine.isLoopBlocked());
    const s6 = engine.checkSafeguard("S6");
    assert.strictEqual(s6.status, "violated");
    assert.ok(s6.details.includes("no diagnosis recorded"));
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("a recorded diagnosis clears the counter — the escape hatch is honoured", () => {
  const { engine, tmp } = engineInPhase5();
  try {
    for (let i = 0; i < LOOP_FAILURE_THRESHOLD; i++) {
      engine.recordTestOutcome("pytest tests/", "fail");
    }
    assert.ok(engine.isLoopBlocked());

    engine.recordDecision(5, "diagnosis", "to_dict() drops the tags relation on M:N");
    assert.ok(!engine.isLoopBlocked(), "a named cause must clear the block");
    assert.strictEqual(engine.checkSafeguard("S6").status, "warning");

    // Aliases must work too, and an unrelated category must not clear it.
    engine.recordTestOutcome("pytest tests/", "fail");
    engine.recordDecision(5, "scope", "unrelated");
    assert.strictEqual(engine.getLoopCounter().count, 1);
    engine.recordDecision(5, "root-cause", "missing null guard");
    assert.strictEqual(engine.getLoopCounter().count, 0);
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("failures in different suites do not compound", () => {
  const { engine, tmp } = engineInPhase5();
  try {
    // S6 speaks of iterations on the same module, so the suite argument must be
    // part of the pattern — otherwise four unrelated suites trip one counter.
    engine.recordTestOutcome("npm test -- consent", "fail");
    engine.recordTestOutcome("npm test -- link", "fail");
    engine.recordTestOutcome("npm test -- export", "fail");
    assert.ok(!engine.isLoopBlocked(), "three different suites are not a loop");
    assert.strictEqual(engine.getLoopCounter().count, 1);
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("a violated safeguard vetoes the transition and says which", () => {
  const { engine, tmp } = engineInPhase5();
  try {
    for (let i = 0; i < LOOP_FAILURE_THRESHOLD; i++) {
      engine.recordTestOutcome("pytest tests/", "fail");
    }
    const result = engine.advancePhase(6);
    assert.ok(!result.ok, "S6 violated must veto the transition");
    if (!result.ok) {
      // The reason used to be computed and discarded, leaving an empty error.
      assert.ok(result.error.safeguardViolations, "the veto must name the safeguard");
      assert.ok(result.error.safeguardViolations!.some((v) => v.startsWith("S6:")));
    }
  } finally {
    cleanTempWorkspace(tmp);
  }
});

console.log("\n=== Ollama Estimator Clamp Tests ===\n");

const PROVIDER_LINE =
  "        this.charsPerToken.set(modelID, (currentCharsPerToken + observedCharsPerToken) / 2);";

function fakeProvider(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "versus-provider-"));
  const file = path.join(dir, "provider.js");
  fs.writeFileSync(file, body, "utf-8");
  return file;
}

test("inspect distinguishes patchable, patched and rewritten providers", () => {
  const plain = fakeProvider(`const defaultCharsPerToken = 4;\n${PROVIDER_LINE}\n`);
  assert.strictEqual(inspect(plain), "patchable");

  applyPatch(plain);
  assert.strictEqual(inspect(plain), "patched");

  // Upstream fixing or rewriting record() must read as unknown, never as
  // patchable — guessing at a changed shape is how you corrupt someone else's
  // extension.
  const rewritten = fakeProvider("this.charsPerToken.set(modelID, tokenize(text));\n");
  assert.strictEqual(inspect(rewritten), "unknown-shape");

  assert.strictEqual(inspect(path.join(os.tmpdir(), "versus-absent", "provider.js")), "missing");
});

test("applyPatch is idempotent, backs up, and preserves the rest of the file", () => {
  const body = `const defaultCharsPerToken = 4;\n// sentinel\n${PROVIDER_LINE}\n// tail\n`;
  const file = fakeProvider(body);

  const first = applyPatch(file);
  assert.ok(first.changed);
  const patched = fs.readFileSync(file, "utf-8");
  assert.ok(patched.includes(PATCH_MARKER));
  assert.ok(patched.includes("Math.max(defaultCharsPerToken"));
  assert.ok(patched.includes("// sentinel") && patched.includes("// tail"));
  assert.strictEqual(fs.readFileSync(`${file}.versus-backup`, "utf-8"), body);

  // A second run must not stack a second clamp — activation calls this every time.
  const second = applyPatch(file);
  assert.ok(!second.changed);
  assert.strictEqual((fs.readFileSync(file, "utf-8").match(/Math\.max/g) ?? []).length, 1);
});

test("revertPatch restores the original byte for byte", () => {
  const body = `const defaultCharsPerToken = 4;\n${PROVIDER_LINE}\n`;
  const file = fakeProvider(body);
  applyPatch(file);
  const result = revertPatch(file);
  assert.ok(result.changed);
  assert.strictEqual(fs.readFileSync(file, "utf-8"), body);
  assert.strictEqual(inspect(file), "patchable");
});

console.log("\n=== Tool Surface Floor Tests ===\n");

test("the tool surface has a minimum viable window, and small models are below it", () => {
  const { ALL_TOOLS } = require("../mcp/tools/index");
  const chars = ALL_TOOLS.reduce(
    (sum: number, t: any) =>
      sum + JSON.stringify({ name: t.name, description: t.description, parameters: t.inputSchema }).length,
    0
  );
  const toolTokens = Math.ceil(chars / 4.4);
  const reserve = 4096;

  // Measured in the Ollama log: every truncation observed was on a window of
  // 8192 or below, none on 32k, 64k or 128k. The schemas alone explain it.
  for (const window of [1024, 2048, 4096]) {
    assert.ok(toolTokens + reserve >= window, `${window} must be flagged as unusable`);
  }
  for (const window of [32768, 65536]) {
    assert.ok(toolTokens + reserve < window, `${window} must not be flagged`);
  }

  // A guard that lets the schemas grow past a working window silently would
  // reintroduce the failure, so pin the surface with room to notice.
  assert.ok(toolTokens < 4000, `tool surface grew to ${toolTokens} tokens`);
});

console.log("\n=== CommonJS Pin Tests ===\n");

test("a CommonJS bundle dies under a type:module project without the pin", () => {
  const { execFileSync } = require("child_process");
  const bundle = path.resolve(__dirname, "..", "bundle", "server.js");
  if (!fs.existsSync(bundle)) {
    console.log("    (skipped: run npm run bundle first)");
    return;
  }

  const project = fs.mkdtempSync(path.join(os.tmpdir(), "versus-esm-"));
  const deployDir = path.join(project, ".versus", "localqwen");
  fs.mkdirSync(deployDir, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ type: "module" }));
  fs.copyFileSync(bundle, path.join(deployDir, "server.js"));

  const handshake =
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05",' +
    '"capabilities":{},"clientInfo":{"name":"t","version":"1"}}}\n';
  const run = () =>
    execFileSync("node", [path.join(deployDir, "server.js"), "--workspace", project], {
      input: handshake,
      encoding: "utf-8",
      timeout: 20000,
      stdio: ["pipe", "pipe", "pipe"],
    });

  try {
    // Without the pin the project's type:module wins and require() is gone.
    let failed = false;
    try { run(); } catch (err: any) {
      failed = true;
      const text = String(err.stderr ?? "") + String(err.message ?? "");
      assert.ok(/require is not defined/.test(text), `expected an ESM failure, got: ${text.slice(0, 200)}`);
    }
    assert.ok(failed, "the bundle must fail without the pin — otherwise this test proves nothing");

    // The pin is what deployBundles/deployServer write beside the bundle.
    fs.writeFileSync(path.join(deployDir, "package.json"), JSON.stringify({ type: "commonjs" }, null, 2) + "\n");
    const out = run();
    assert.ok(out.includes('"serverInfo"'), "handshake must succeed once CommonJS is pinned");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

console.log("\n=== Evidence Gate Tests ===\n");

/**
 * The per-round lens set Phase 2 owes, through the real tool so the fixture is
 * subject to the same validation a model is. The round is derived by the engine,
 * not passed in.
 */
function declareLenses(engine: StateEngine): void {
  const activated = ["Resilience", "Mechanical Engineering"];
  const refused = CONDITIONAL_LENSES.filter((l) => !activated.includes(l)).map((lens) => ({
    lens,
    reason: "no project signal for it in this cycle",
  }));
  const res = JSON.parse(
    handleRecordActivatedLenses(engine, { conditional: activated, notActivated: refused })
  );
  assert.strictEqual(res.success, true, `the fixture itself must be valid: ${res.problems}`);
}

function markAll(engine: StateEngine, phase: number): void {
  const { getExitCriteriaForPhase } = require("../rules/phases");
  for (const def of getExitCriteriaForPhase(phase)) {
    engine.markExitCriterion(phase, def.criterion, true, "test");
  }
}

function engineAt(phase: number): { engine: StateEngine; tmp: string } {
  const tmp = createTempWorkspace();
  const engine = new StateEngine(tmp);
  engine.initProject("gates", "evidence");
  const st = engine.getPhaseState()!;
  (st as any).currentPhase = phase;
  engine.recordDecision(phase, "scope", "phase forced for test");
  return { engine, tmp };
}

test("a marked criterion does not advance without its artifact on disk", () => {
  const { engine, tmp } = engineAt(1);
  try {
    markAll(engine, 1);
    const blocked = engine.advancePhase(2);
    assert.ok(!blocked.ok, "every criterion is met, but the artifact is absent");
    if (!blocked.ok) {
      assert.ok(
        blocked.error.missingCriteria.some((m) => m.includes("specs/technical/architecture.md")),
        "the block must name the missing file, not just refuse"
      );
    }

    writeArchitectureDoc(tmp);
    assert.ok(engine.advancePhase(2).ok, "the artifact must unblock it");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("a prose architecture blocks P1 to P2, and the message names the module row", () => {
  const { engine, tmp } = engineAt(1);
  try {
    markAll(engine, 1);
    writeArchitectureDoc(tmp, PROSE_ARCHITECTURE);

    // Prose clears the size floor; it is the structure that is missing.
    assert.ok(engine.artifactPresent("technical/architecture.md"));
    const blocked = engine.advancePhase(2);
    assert.ok(!blocked.ok, "a prose decomposition cannot be machine-read");
    if (!blocked.ok) {
      const msg = blocked.error.missingCriteria.join(" ");
      // The example has to come from the criterion: two artifacts share this
      // mechanism, and a shared message would ask for the wrong shape.
      assert.ok(msg.includes("M-01 | rate-limiter"), `wrong example in: ${msg}`);
      assert.ok(!msg.includes("P-01 | auth"), "must not ask for a findings row here");
    }

    writeArchitectureDoc(tmp);
    assert.ok(engine.advancePhase(2).ok, "a module table unblocks it");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("a trivial artifact does not count as evidence", () => {
  const { engine, tmp } = engineAt(2);
  try {
    markAll(engine, 2);
    declareLenses(engine);
    // A heading alone is the shape of a file written to satisfy a checker.
    writeCoverageMatrix(tmp, "# Coverage Matrix\n");
    const thin = engine.advancePhase(3);
    assert.ok(!thin.ok, "80 non-whitespace chars is the floor");
    if (!thin.ok) {
      assert.ok(
        thin.error.missingCriteria.some(
          (m) => m.includes("design/coverage-matrix.md") && m.includes("missing or")
        ),
        "the block must name the file and say it is empty, not just refuse"
      );
    }

    writeCoverageMatrix(tmp);
    assert.ok(engine.advancePhase(3).ok);
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("the row floor stays at the minimum that rejects the wrong shape", () => {
  // count is 1, not 3, on purpose: the gate has to reject an id-less grid (zero
  // finding rows) without demanding a number of findings. In a study whose
  // metric is finding count, a higher floor would be the tool manufacturing its
  // own result.
  const { getExitCriteriaForPhase } = require("../rules/phases");
  const def = getExitCriteriaForPhase(2).find((d: any) => d.criterion === "coverage_matrix");
  assert.strictEqual(def.artifactRows.count, 1);
});

test("a severity grid is long enough but not analysable, so it blocks", () => {
  const { engine, tmp } = engineAt(2);
  try {
    markAll(engine, 2);
    declareLenses(engine);
    writeCoverageMatrix(tmp, SEVERITY_GRID);

    // The grid clears the size floor — that is the whole point of the structural
    // gate: a cell holding 🔴 says a lens found something, not what.
    assert.ok(engine.artifactPresent("design/coverage-matrix.md"));
    const blocked = engine.advancePhase(3);
    assert.ok(!blocked.ok, "a grid of severities cannot be worked from");
    if (!blocked.ok) {
      assert.ok(
        // The example is what tells the model which shape is wanted, and it
        // must be the matrix one here — not the module row.
        blocked.error.missingCriteria.some(
          (m) => m.includes("P-01 | auth") && !m.includes("M-01 | rate-limiter")
        ),
        "the block must name the shape it wants"
      );
    }

    writeCoverageMatrix(tmp);
    assert.ok(engine.advancePhase(3).ok, "a findings table unblocks it");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("an echo of the module table is not a set of findings", () => {
  const { engine, tmp } = engineAt(2);
  try {
    markAll(engine, 2);
    declareLenses(engine);
    // Phase 1 now writes M-01 ids, and M fits [A-Za-z]{1,4}. Copying that table
    // into the matrix produced a file with zero findings that passed the gate.
    writeCoverageMatrix(tmp, MODULE_ECHO);
    const echo = engine.advancePhase(3);
    assert.ok(!echo.ok, "a matrix with no findings must not pass");
    if (!echo.ok) {
      assert.ok(
        echo.error.missingCriteria.some(
          (m) => m.includes("structured form") && m.includes("P-01 | auth")
        ),
        "the block must show the finding row it wants, not the module one"
      );
    }

    // The lookahead must not take Mechanical Engineering with it.
    writeCoverageMatrix(tmp, MECHANICAL_FINDING);
    assert.ok(engine.advancePhase(3).ok, "MEC- is a finding prefix, not a module one");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("the reserved module prefix is stated in the guidance", () => {
  // The lookahead alone would silently drop a finding a model chose to prefix
  // M-, so the rule has to be told, not just enforced.
  const g = getCompleteGuidance();
  assert.ok(g.includes("RESERVED for modules"));
  assert.ok(g.includes("MEC-"), "the alternative prefix must be named");
});

test("countArtifactRows counts findings, not grid rows", () => {
  const { engine, tmp } = engineAt(2);
  try {
    const { getExitCriteriaForPhase } = require("../rules/phases");
    const def = getExitCriteriaForPhase(2).find((d: any) => d.criterion === "coverage_matrix");
    const pattern = def.artifactRows.pattern;

    writeCoverageMatrix(tmp);
    assert.strictEqual(engine.countArtifactRows("design/coverage-matrix.md", pattern), 3);

    writeCoverageMatrix(tmp, SEVERITY_GRID);
    assert.strictEqual(engine.countArtifactRows("design/coverage-matrix.md", pattern), 0);

    assert.strictEqual(engine.countArtifactRows("design/absent.md", pattern), 0);
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("tests_passing needs a pass witnessed in this phase", () => {
  const { engine, tmp } = engineAt(6);
  try {
    markAll(engine, 6);

    const noRun = engine.advancePhase(7);
    assert.ok(!noRun.ok, "marking it met is not evidence");
    if (!noRun.ok) {
      assert.ok(noRun.error.missingCriteria.some((m) => m.includes("record_test_outcome")),
        "the block must name the escape, since no hook will report for the model");
    }

    // A failing run is a witnessed run, but not a passing one.
    engine.recordTestOutcome("pytest", "fail");
    const failed = engine.advancePhase(7);
    assert.ok(!failed.ok, "a failure must not satisfy the gate");
    if (!failed.ok) {
      assert.ok(failed.error.missingCriteria.some((m) => m.includes("no passing test run was witnessed")));
    }

    engine.recordTestOutcome("pytest", "pass");
    assert.ok(engine.advancePhase(7).ok, "a witnessed pass unblocks it");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("a pass witnessed in an earlier phase does not carry forward", () => {
  const { engine, tmp } = engineAt(5);
  try {
    engine.recordTestOutcome("pytest", "pass");
    const st = engine.getPhaseState()!;
    (st as any).currentPhase = 6;
    engine.recordDecision(6, "scope", "moved on");
    markAll(engine, 6);
    const stale = engine.advancePhase(7);
    assert.ok(!stale.ok, "the pass belonged to Phase 5");
    if (!stale.ok) {
      assert.ok(stale.error.missingCriteria.some((m) => m.includes("witnessed in this phase")));
    }
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("start_new_cycle requires the lessons file", () => {
  const { engine, tmp } = engineAt(7);
  try {
    markAll(engine, 7);
    const blocked = engine.startNewCycle();
    assert.ok(!blocked.ok);
    if (!blocked.ok) assert.ok(String(blocked.error).includes("specs/references/lessons.md"));

    writeSpecArtifact(tmp, "references/lessons.md");
    assert.ok(engine.startNewCycle().ok);
  } finally {
    cleanTempWorkspace(tmp);
  }
});

// --- Per-iteration traceability (RO3 contract) ---

console.log("\n=== Loop Traceability Tests ===\n");

/** Drives a fresh project up to Phase 2 with the architecture on disk. */
function atPhase2(): { engine: StateEngine; tmp: string } {
  const tmp = createTempWorkspace();
  const e = new StateEngine(tmp);
  e.initProject("loop", "traceability");
  e.updateScore(95, makeFullBreakdown(95));
  markAll(e, 0);
  e.advancePhase(1);
  markAll(e, 1);
  writeArchitectureDoc(tmp);
  e.advancePhase(2);
  return { engine: e, tmp };
}

test("Phase 2 will not advance without a lens declaration for this round", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    markAll(e, 2);
    writeCoverageMatrix(tmp);
    const blocked = e.advancePhase(3);
    assert.ok(!blocked.ok, "every criterion is marked, but nothing declared the lens set");
    if (!blocked.ok) {
      assert.ok(
        blocked.error.missingCriteria.some((m) => m.includes("no lens set recorded for iteration 1")),
        "the block must name the round it wants"
      );
    }
    declareLenses(e);
    assert.ok(e.advancePhase(3).ok, "the recorded set unblocks it");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

/** The prose declaration is the old format: honoured only where it was all there was. */
const PROSE_DECLARATION =
  "LENTES ATIVADAS — iteração 1, contra V(1). Universais (7): todas. " +
  "Condicionais ATIVADAS (1): Resilience. NÃO ativadas, com justificativa: UI/UX (sem interface).";

test("prose does not satisfy the gate in a project created with a stateVersion", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    markAll(e, 2);
    writeCoverageMatrix(tmp);
    e.recordDecision(2, "architecture", PROSE_DECLARATION);
    const blocked = e.advancePhase(3);
    assert.ok(!blocked.ok, "the fallback must not become an opt-out in a new project");
    if (!blocked.ok) {
      assert.ok(blocked.error.missingCriteria.some((m) => m.includes("record_activated_lenses")));
    }
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("prose still satisfies the gate in a project written before stateVersion", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    // What a pre-0.8.0 state.json looks like: no format stamp at all.
    delete (e.getPhaseState() as any).stateVersion;
    markAll(e, 2);
    writeCoverageMatrix(tmp);
    e.recordDecision(2, "architecture", PROSE_DECLARATION);
    assert.ok(e.advancePhase(3).ok, "a legacy project is not retroactively broken");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("the recorded set persists per round, with its version", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    declareLenses(e);
    const first = e.getPhaseState()!.activatedLenses!;
    assert.strictEqual(first.length, 1);
    assert.strictEqual(first[0].iteration, 1);
    assert.strictEqual(first[0].againstVersion, 1, "one module table, no ## V(N) heading yet");
    assert.deepStrictEqual(first[0].universal, [...UNIVERSAL_LENSES]);
    assert.strictEqual(first[0].notActivated.length, CONDITIONAL_LENSES.length - 2);

    // Re-recording the same round is a correction, not a second declaration.
    declareLenses(e);
    assert.strictEqual(e.getPhaseState()!.activatedLenses!.length, 1);

    // A new round pushes, so the history the lens gate reads survives.
    markAll(e, 2);
    writeCoverageMatrix(tmp);
    assert.ok(e.advancePhase(3).ok);
    markAll(e, 3);
    assert.ok(e.advancePhase(2).ok);
    declareLenses(e);
    const rounds = e.getPhaseState()!.activatedLenses!;
    assert.deepStrictEqual(rounds.map((r) => r.iteration), [1, 2]);
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("re-entering Phase 2 opens a new round and asks for its own declaration", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    markAll(e, 2);
    declareLenses(e);
    writeCoverageMatrix(tmp);
    assert.ok(e.advancePhase(3).ok);
    assert.strictEqual(e.getPhaseState()!.currentIteration, 1, "2→3 stays inside round 1");

    markAll(e, 3);
    assert.ok(e.advancePhase(2).ok, "the loop back is always allowed");
    assert.strictEqual(e.getPhaseState()!.currentIteration, 2, "3→2 opens round 2");

    // The whole round resets, not just the declaration: a new critique of a new
    // architecture re-produces the findings, the criticals and the concentration
    // too, and leaving those marked let V(1)'s critique stand in for V(2).
    const criteria = e.getExitCriteriaWithDefs(2);
    assert.ok(criteria.length >= 5, "Phase 2 has more than one criterion to reset");
    assert.deepStrictEqual(
      criteria.filter((c) => c.met).map((c) => c.criterion),
      [],
      "every Phase 2 criterion is owed again"
    );
    // Phase 3 resets too: it will be redone against the new design, and its
    // criticals_addressed from round 1 answered round 1's criticals.
    assert.deepStrictEqual(
      e.getExitCriteriaWithDefs(3).filter((c) => c.met).map((c) => c.criterion),
      [],
      "the loop is symmetric — both phases of it are redone"
    );
    // Phases outside the loop are left alone.
    assert.ok(e.getExitCriteriaWithDefs(1).every((c) => c.met), "Phase 1 is not in the loop");

    // Round 1's declaration must not satisfy round 2 — that is the accumulation
    // this whole mechanism exists to prevent.
    markAll(e, 2);
    const blocked = e.advancePhase(3);
    assert.ok(!blocked.ok);
    if (!blocked.ok) {
      assert.ok(blocked.error.missingCriteria.some((m) => m.includes("iteration 2")));
    }

    declareLenses(e);
    // Round 2 also owes its own section in the matrix; without it every finding
    // in the file would read as round 1.
    const stillRound1 = e.advancePhase(3);
    assert.ok(!stillRound1.ok, "the matrix still only has iteration 1");
    if (!stillRound1.ok) {
      assert.ok(stillRound1.error.missingCriteria.some((m) => m.includes("no section for iteration 2")));
    }

    writeCoverageMatrix(tmp, [
      FINDINGS_TABLE,
      "",
      "## Iteração 2 — V(2)",
      "",
      "| id | module | lens | severity | description |",
      "|----|--------|------|----------|-------------|",
      "| RES-01 | store | Resilience | 🟡 | a failed write leaves the counter behind |",
    ].join("\n"));
    assert.ok(e.advancePhase(3).ok);
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("after a loop, Phase 4 waits for Phase 3 to be answered again", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    // 2→3 · 3→2 · 2→3, then the gate to Phase 4.
    markAll(e, 2);
    declareLenses(e);
    writeCoverageMatrix(tmp);
    assert.ok(e.advancePhase(3).ok);
    markAll(e, 3);
    assert.ok(e.advancePhase(2).ok);

    markAll(e, 2);
    declareLenses(e);
    writeCoverageMatrix(tmp, [
      FINDINGS_TABLE,
      "",
      "## Iteração 2 — V(2)",
      "",
      "| id | module | lens | severity | description |",
      "|----|--------|------|----------|-------------|",
      "| RES-01 | store | Resilience | 🟡 | a failed write leaves the counter behind |",
    ].join("\n"));
    assert.ok(e.advancePhase(3).ok);

    // Round 1's stamp answered round 1's criticals, so it cannot open Phase 4.
    const blocked = e.advancePhase(4);
    assert.ok(!blocked.ok, "the Phase 3 criteria were earned before the second critique");
    if (!blocked.ok) {
      assert.ok(blocked.error.missingCriteria.some((m) => m.includes("criticals_addressed")));
    }

    markAll(e, 3);
    assert.ok(e.advancePhase(4).ok, "re-answering Phase 3 opens the gate");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("a finding citing a module no version declares is drift, and blocks", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    markAll(e, 2);
    declareLenses(e);
    writeCoverageMatrix(tmp, [
      "## Iteração 1 — V(1)",
      "",
      "| id | module | lens | severity | description |",
      "|----|--------|------|----------|-------------|",
      "| P-01 | quota-limiter | Security | 🔴 | the module is called rate-limiter |",
    ].join("\n"));
    const blocked = e.advancePhase(3);
    assert.ok(!blocked.ok, "a name in no version of the architecture is drift");
    if (!blocked.ok) {
      assert.ok(
        blocked.error.missingCriteria.some((m) => m.includes("quota-limiter")),
        "the block must name the module that drifted"
      );
    }

    writeCoverageMatrix(tmp);
    assert.ok(e.advancePhase(3).ok, "the Phase 1 name unblocks it");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("a dependency cell holding a module id does not hide the next module", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    // The shape that broke RestaUm: `depends-on` naming M-01. A global regex
    // matched `| M-01 |` plus the newline plus the pipe OPENING the next row,
    // consuming it, so M-03 was never seen and `game` looked absent from an
    // architecture that plainly declared it — while board and ui resolved.
    writeArchitectureDoc(tmp, [
      "| id | module | responsibility | interface | depends-on |",
      "|------|-------|----------------|-----------|------------|",
      "| M-01 | board | state and rules | legalMoves(state) | — |",
      "| M-02 | ui | rendering and input | render(state) | M-01 |",
      "| M-03 | game | orchestration | initGame(el) | M-01, M-02 |",
    ].join("\n"));
    markAll(e, 2);
    declareLenses(e);
    writeCoverageMatrix(tmp, [
      "## Iteração 1 — V(1)",
      "",
      "| id | module | lens | severity | description |",
      "|----|--------|------|----------|-------------|",
      "| P-01 | game | Security | 🟡 | the module after the one carrying a dependency |",
    ].join("\n"));
    assert.ok(e.advancePhase(3).ok, "M-03 is declared; the parser must see it");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("a module removed between versions is tolerated, not drift", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    // rate-limiter exists in V(1) and is gone from V(2). Iteration 1 raised a
    // finding against it, which stays legitimate — checking only the last
    // version would block every project whose design actually evolved.
    writeArchitectureDoc(tmp, [
      "## V(1)",
      "",
      MODULE_TABLE,
      "",
      "## V(2)",
      "",
      "| id | module | responsibility | interface | depends-on |",
      "|------|-------|--------------------|-----------------------|---|",
      "| M-01 | store | counters and quota | get(key) / allow(key) | — |",
    ].join("\n"));
    markAll(e, 2);
    declareLenses(e);
    writeCoverageMatrix(tmp, [
      "## Iteração 1 — V(1)",
      "",
      "| id | module | lens | severity | description |",
      "|----|--------|------|----------|-------------|",
      "| P-01 | rate-limiter | Security | 🔴 | raised against V(1), where it existed |",
    ].join("\n"));
    assert.ok(e.advancePhase(3).ok, "the union of versions is what counts");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("projectSpec entries carry the phase and the moment they were recorded", () => {
  engine.initProject("spec", "stamps");
  engine.updateProjectSpec({ stack: ["TypeScript"] });
  const [first] = engine.getProjectSpec().stack;
  assert.strictEqual(typeof first, "object");
  assert.strictEqual((first as any).value, "TypeScript");
  assert.strictEqual((first as any).phase, 0);
  assert.ok(!Number.isNaN(Date.parse((first as any).at)), "the stamp must be a real instant");

  // Re-adding must not move the date forward: the question is when the project
  // first knew this, not when it last repeated it.
  const at = (first as any).at;
  engine.updateProjectSpec({ stack: ["TypeScript", "Node 18+"] });
  const stack = engine.getProjectSpec().stack;
  assert.strictEqual(stack.length, 2, "the repeat is not a second entry");
  assert.strictEqual((stack[0] as any).at, at);
});

test("a spec written before the stamps still reads", () => {
  engine.initProject("spec", "back-compat");
  // What 0.6.x wrote to disk.
  (engine.getPhaseState() as any).projectSpec = {
    stack: ["TypeScript"], outOfScope: [], patterns: [], constraints: [],
  };
  engine.updateProjectSpec({ stack: ["TypeScript", "Node 18+"] });
  const stack = engine.getProjectSpec().stack;
  assert.strictEqual(stack.length, 2, "the bare string is the same entry, not a new one");
  assert.strictEqual(stack[0], "TypeScript", "old entries are left as they were");
  assert.strictEqual((stack[1] as any).value, "Node 18+");
});

test("the three widened lens triggers are the ones in the table", () => {
  // Each of these activated in 0/7 pilots because the trigger was narrower than
  // the lens's own central question, or measured something else entirely.
  const g = getCompleteGuidance();
  assert.ok(g.includes("Any surface a PERSON operates"), "UI/UX covers a CLI");
  assert.ok(g.includes("whose cost grows with use"), "Sustainability is not an AI/ML checklist");
  assert.ok(g.includes("This is a SYSTEM property"), "Governance is not only multi-team");
  assert.ok(!g.includes("| User-facing interface |"), "the narrow trigger is gone");
});

test("the guidance states the contract the analysis reads", () => {
  const g = getCompleteGuidance();
  // The iteration token is Portuguese on purpose — it is what downstream matches.
  assert.ok(g.includes("## Iteração 2 — V(2)"), "the matrix section heading");
  assert.ok(g.includes("record_activated_lenses"), "the tool that replaced the prose declaration");
  assert.ok(!g.includes("LENTES ATIVADAS"), "the prose format is no longer taught");
  assert.ok(/Activation is by PROJECT SIGNAL/.test(g), "redundancy is not grounds to skip a lens");
  assert.ok(/duplica\S* applies \*\*within a single lens/.test(g), "duplica within one lens");
});


// --- Structured lens declaration and the lens column (RO3 v0.8.0) ---

console.log("\n=== Lens Tests ===\n");

/** Calls the tool directly, so the refusals are tested where they live. */
function record(engine: StateEngine, conditional: unknown, notActivated: unknown): any {
  return JSON.parse(handleRecordActivatedLenses(engine, { conditional, notActivated } as any));
}

/** All 12 accounted for: `activated` on, the rest refused with a reason. */
function payload(activated: string[], reason = "no signal") {
  return {
    conditional: activated,
    notActivated: CONDITIONAL_LENSES.filter((l) => !activated.includes(l)).map((lens) => ({ lens, reason })),
  };
}

test("canonicalLens tolerates case and slash spacing, nothing else", () => {
  assert.strictEqual(canonicalLens("ui / ux"), "UI/UX");
  assert.strictEqual(canonicalLens("SECURITY"), "Security");
  assert.strictEqual(canonicalLens("Sustainability / Proportionality"), "Sustainability / Proportionality");
  // The T21 failure: a truncation is a different name, not a spelling variant.
  assert.strictEqual(canonicalLens("Sustainability"), null);
  assert.strictEqual(canonicalLens("Segurança"), null);
  assert.strictEqual(canonicalLens("SEG"), null);
});

test("record_activated_lenses refuses a translation or an abbreviation", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    const p = payload(["Resilience"]);
    const pt = record(e, ["Resiliência"], p.notActivated);
    assert.strictEqual(pt.success, false);
    assert.ok(pt.problems.some((x: string) => x.includes("'Resiliência' is not a lens name")),
      "the refusal must quote what was sent");

    const abbrev = record(e, ["RES"], p.notActivated);
    assert.strictEqual(abbrev.success, false);
    assert.ok(abbrev.problems.some((x: string) => x.includes("'RES' is not a lens name")));

    assert.strictEqual(record(e, ["Resilience"], p.notActivated).success, true);
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("record_activated_lenses requires all 12 to be accounted for", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    const res = record(e, ["Resilience"], [{ lens: "UI/UX", reason: "no interface" }]);
    assert.strictEqual(res.success, false);
    assert.ok(res.problems.some((p: string) => p.includes("Not accounted for")));
    assert.ok(res.problems.some((p: string) => p.includes("Game Theory")), "name the ones missing");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("record_activated_lenses refuses a refusal with no reason", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    const p = payload(["Resilience"], "");
    const res = record(e, p.conditional, p.notActivated);
    assert.strictEqual(res.success, false);
    assert.ok(res.problems.some((x: string) => x.includes("has no reason")));
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("record_activated_lenses refuses a universal lens as conditional", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    // canonicalLens accepts all 19; the count of CONDITIONAL lenses is the
    // measured variable, so a universal smuggled in would inflate it.
    const p = payload(["Resilience"]);
    let res = record(e, ["Resilience", "Security"], p.notActivated);
    assert.strictEqual(res.success, false);
    assert.ok(res.problems.some((x: string) => x.includes("UNIVERSAL")));

    res = record(e, p.conditional, [...p.notActivated, { lens: "Security", reason: "x" }]);
    assert.strictEqual(res.success, false);
    assert.ok(res.problems.some((x: string) => x.includes("UNIVERSAL")));
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("record_activated_lenses refuses a lens that is both activated and not", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    const notActivated = CONDITIONAL_LENSES.map((lens) => ({ lens, reason: "no signal" }));
    const res = record(e, ["Resilience"], notActivated);
    assert.strictEqual(res.success, false);
    assert.ok(res.problems.some((x: string) => x.includes("activated AND as not activated")));
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("record_activated_lenses refuses a duplicate", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    const p = payload(["Resilience"]);
    // Duplicated, it would pass the completeness count while claiming two lenses.
    const res = record(e, ["Resilience", "resilience"], p.notActivated);
    assert.strictEqual(res.success, false);
    assert.ok(res.problems.some((x: string) => x.includes("appears twice")));
  } finally {
    cleanTempWorkspace(tmp);
  }
});

/** Builds a one-round matrix with the given lens in the 3rd column. */
function matrixWithLens(lens: string, iteration = 1): string {
  return [
    `## Iteração ${iteration} — V(${iteration})`,
    "",
    "| id | module | lens | severity | description |",
    "|----|--------|------|----------|-------------|",
    `| X-0${iteration} | store | ${lens} | 🟡 | a finding whose lens column is what is under test |`,
  ].join("\n");
}

test("a truncated lens name blocks 2→3 (the T21 failure)", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    markAll(e, 2);
    declareLenses(e);
    writeCoverageMatrix(tmp, matrixWithLens("Sustainability"));
    const blocked = e.advancePhase(3);
    assert.ok(!blocked.ok, "the row gate only ever read the first cell");
    if (!blocked.ok) {
      const msg = blocked.error.missingCriteria.join(" ");
      assert.ok(msg.includes("X-01"), "name the row");
      assert.ok(msg.includes("'Sustainability'"), "and quote what was written");
    }
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("NENHUMA and slash spacing pass the lens column", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    markAll(e, 2);
    declareLenses(e);
    writeCoverageMatrix(tmp, matrixWithLens("NENHUMA"));
    assert.ok(e.advancePhase(3).ok, "a finding that fit no lens has a channel");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("a conditional lens is checked against the round that declared it", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    // Round 1 activates Resilience and Mechanical Engineering only.
    markAll(e, 2);
    declareLenses(e);
    writeCoverageMatrix(tmp, matrixWithLens("Mechanical Engineering", 1));
    assert.ok(e.advancePhase(3).ok, "declared for round 1, used in round 1");

    // Round 2 activates Game Theory instead. The T14 case: the set evolves.
    markAll(e, 3);
    assert.ok(e.advancePhase(2).ok);
    markAll(e, 2);
    const p = payload(["Game Theory"]);
    assert.strictEqual(record(e, p.conditional, p.notActivated).success, true);

    // Round 2 using round 1's lens is anachronistic in the other direction.
    writeCoverageMatrix(tmp, [matrixWithLens("Mechanical Engineering", 1), "", matrixWithLens("Mechanical Engineering", 2)].join("\n"));
    const blocked = e.advancePhase(3);
    assert.ok(!blocked.ok, "round 2 never activated Mechanical Engineering");
    if (!blocked.ok) {
      const msg = blocked.error.missingCriteria.join(" ");
      assert.ok(msg.includes("Mechanical Engineering"));
      assert.ok(msg.includes("iteration 2"), "name the round that did not declare it");
    }

    // Round 2 using its own lens passes, and round 1's row is still fine.
    writeCoverageMatrix(tmp, [matrixWithLens("Mechanical Engineering", 1), "", matrixWithLens("Game Theory", 2)].join("\n"));
    assert.ok(e.advancePhase(3).ok, "each row answers to its own round");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("an unresolvable round degrades to the union, never blocking a legitimate project", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    markAll(e, 2);
    declareLenses(e);
    // No iteration heading at all: the round is unknown, so the permissive set
    // applies. Being wrong here must cost a missed check, not a blocked project.
    writeCoverageMatrix(tmp, [
      "| id | module | lens | severity | description |",
      "|----|--------|------|----------|-------------|",
      "| X-01 | store | Resilience | 🟡 | no heading above it |",
    ].join("\n"));
    assert.ok(e.advancePhase(3).ok);
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("a conditional lens no round ever declared blocks", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    markAll(e, 2);
    declareLenses(e);
    writeCoverageMatrix(tmp, matrixWithLens("Game Theory", 1));
    const blocked = e.advancePhase(3);
    assert.ok(!blocked.ok, "a lens applied without being activated is not a critique");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

/** A one-row matrix whose severity cell is what is under test. */
function matrixWithSeverity(severity: string): string {
  return [
    "## Iteração 1 — V(1)",
    "",
    "| id | module | lens | severity | description |",
    "|----|--------|------|----------|-------------|",
    `| S-01 | store | Security | ${severity} | the severity column is what is under test |`,
  ].join("\n");
}

/** Runs the 2→3 gate over a matrix, with everything else already earned. */
function gateWith(body: string): { ok: boolean; why: string } {
  const { engine: e, tmp } = atPhase2();
  try {
    markAll(e, 2);
    declareLenses(e);
    writeCoverageMatrix(tmp, body);
    const r = e.advancePhase(3);
    return { ok: r.ok, why: r.ok ? "" : r.error.missingCriteria.join(" ") };
  } finally {
    cleanTempWorkspace(tmp);
  }
}

test("the three severity glyphs pass", () => {
  for (const g of ["🔴", "🟡", "🟢"]) {
    assert.ok(gateWith(matrixWithSeverity(g)).ok, `${g} is a severity`);
  }
});

test("a severity word instead of a glyph blocks", () => {
  // The analysis counts criticals against important on this column, so a value
  // it cannot count is a wrong count, not a missing one.
  const r = gateWith(matrixWithSeverity("high"));
  assert.ok(!r.ok);
  assert.ok(r.why.includes("S-01"), "name the row");
  assert.ok(r.why.includes('"high"'), "and quote the cell");
});

test("an empty severity cell blocks", () => {
  const r = gateWith(matrixWithSeverity(" "));
  assert.ok(!r.ok);
  assert.ok(r.why.includes("(empty)"));
});

test("two glyphs in one cell block — the level is ambiguous", () => {
  const r = gateWith(matrixWithSeverity("🔴🟡"));
  assert.ok(!r.ok);
  assert.ok(r.why.includes("S-01") && r.why.includes("🔴🟡"), "name the row and quote the cell");
});

test("a glyph with a word beside it passes — decoration is not the signal", () => {
  assert.ok(gateWith(matrixWithSeverity("🔴 Critical")).ok);
});

test("the Phase 2 lens tables render from lenses.ts", () => {
  // Moving the table from hand-written markdown to data must not change one byte
  // of what the model reads — that is the whole point of the consolidation.
  const g = getCompleteGuidance();
  assert.ok(g.includes("| Lens | Central Question | Exclusive Failure Class | Activate when... |"));
  for (const l of [...UNIVERSAL_LENS_DEFS, ...CONDITIONAL_LENS_DEFS]) {
    assert.ok(g.includes(`| ${l.name} | ${l.question} |`), `${l.name} renders its question`);
  }
  // The three triggers widened in 0.7.3 come from the defs now, not from prose.
  assert.ok(g.includes("Any surface a PERSON operates"));
  assert.ok(g.includes("whose cost grows with use"));
  assert.ok(g.includes("This is a SYSTEM property"));
});

test("the 19 canonical names are the ones the guidance teaches", () => {
  const g = getCompleteGuidance();
  for (const lens of [...UNIVERSAL_LENSES, ...CONDITIONAL_LENSES]) {
    assert.ok(g.includes(lens), `the guidance must spell '${lens}' the way lenses.ts does`);
  }
});


// --- Post-batch: test-outcome integrity, provenance, Phase 6 re-verification ---

console.log("\n=== Integrity Tests ===\n");

test("an inconclusive run is recorded, satisfies nothing, and counts nothing", () => {
  const { engine, tmp } = engineAt(6);
  try {
    // A stale failure must not survive as the last thing anyone knew...
    engine.recordTestOutcome("pytest", "fail");
    const before = engine.getPhaseState()!.loopCounter.count;
    engine.recordTestOutcome("pytest", "unknown");
    const t = engine.getPhaseState()!.lastTestOutcome!;
    assert.strictEqual(t.outcome, "unknown", "it overwrites the stale fail");

    // ...and it must not move S6 either way.
    assert.strictEqual(engine.getPhaseState()!.loopCounter.count, before, "S6 does not count it");

    markAll(engine, 6);
    const blocked = engine.advancePhase(7);
    assert.ok(!blocked.ok, "'could not tell' is not a pass");
    if (!blocked.ok) {
      assert.ok(
        blocked.error.missingCriteria.some((m) => m.includes("could not be classified")),
        "the refusal must distinguish unreadable from red"
      );
    }
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("the tests_passing refusal quotes what is on record", () => {
  const { engine, tmp } = engineAt(6);
  try {
    markAll(engine, 6);
    const never = engine.advancePhase(7);
    assert.ok(!never.ok);
    if (!never.ok) {
      assert.ok(
        never.error.missingCriteria.some((m) => m.includes("Nothing has been recorded for this phase")),
        "not observed and failed call for opposite next moves"
      );
    }

    engine.recordTestOutcome("pytest -k consent", "fail");
    const red = engine.advancePhase(7);
    assert.ok(!red.ok);
    if (!red.ok) {
      const msg = red.error.missingCriteria.join(" ");
      assert.ok(msg.includes("the last run failed"));
      assert.ok(msg.includes("pytest -k consent"), "name the command it read");
    }
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("get_phase_state exposes the last test outcome", () => {
  engine.initProject("state", "outcome");
  // Through the tool, which is what a model calls — and where provenance is set.
  handleRecordTestOutcome(engine, { command: "npm test", outcome: "fail" });
  const res = JSON.parse(handleGetPhaseState(engine));
  assert.strictEqual(res.lastTestOutcome.outcome, "fail");
  assert.strictEqual(res.lastTestOutcome.command, "npm test");
  assert.strictEqual(res.lastTestOutcome.provenance.source, "mcp-tool");
  assert.ok(res.lastTestOutcome.provenance.note.includes("no exit status reported"));
});

test("record_test_outcome defaults to unknown rather than guessing a verdict", () => {
  engine.initProject("tool", "outcome");
  const res = JSON.parse(handleRecordTestOutcome(engine, { command: "pytest" } as any));
  assert.strictEqual(res.recorded, "unknown");
  // The old boolean still answers, for a caller written against the old schema.
  const legacy = JSON.parse(handleRecordTestOutcome(engine, { command: "pytest", failed: false } as any));
  assert.strictEqual(legacy.recorded, "pass");
});

test("a passing transition stamps HOW each verify criterion was satisfied", () => {
  const { engine, tmp } = engineAt(6);
  try {
    engine.recordTestOutcome("pytest", "pass");
    markAll(engine, 6);
    assert.ok(engine.advancePhase(7).ok);

    const stamped = engine
      .getPhaseState()!
      .exitCriteria.find((c) => c.phase === 6 && c.criterion === "tests_passing")!;
    assert.ok(stamped.verifiedBy, "the checkbox must carry how, not only that");
    assert.strictEqual(stamped.verifiedBy!.path, "test-pass");
    // No hook on this host, so no exit code was observed: a degraded path, and
    // it should read as one afterwards instead of like the strong path.
    assert.strictEqual(stamped.verifiedBy!.nominal, false);
    assert.ok(stamped.verifiedBy!.note!.includes("without an exit status"));
    assert.ok(stamped.verifiedBy!.snapshot!.includes("pytest"));
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("the lens criterion records whether the structured path or the fallback was used", () => {
  const { engine: e, tmp } = atPhase2();
  try {
    markAll(e, 2);
    declareLenses(e);
    writeCoverageMatrix(tmp);
    assert.ok(e.advancePhase(3).ok);
    const strong = e
      .getPhaseState()!
      .exitCriteria.find((c) => c.phase === 2 && c.criterion === "activated_lenses_recorded")!;
    assert.strictEqual(strong.verifiedBy!.nominal, true);
    assert.ok(strong.verifiedBy!.snapshot!.includes("Resilience"));
  } finally {
    cleanTempWorkspace(tmp);
  }
});

/** Phase 6 with the artifacts of a project that raised criticals. */
function engineAtPhase6WithCriticals(): { engine: StateEngine; tmp: string } {
  const { engine: e, tmp } = engineAt(6);
  writeArchitectureDoc(tmp);
  writeCoverageMatrix(tmp);
  e.recordTestOutcome("pytest", "pass");
  markAll(e, 6);
  return { engine: e, tmp };
}

test("a critical with nothing said about it blocks 6→7", () => {
  const { engine: e, tmp } = engineAtPhase6WithCriticals();
  try {
    const blocked = e.advancePhase(7);
    assert.ok(!blocked.ok, "P-01 is 🔴 and no file answers for it");
    if (!blocked.ok) {
      const msg = blocked.error.missingCriteria.join(" ");
      assert.ok(msg.includes("critical-coverage.md"));
      assert.ok(msg.includes("P-01"), "name the critical it wants answered");
    }

    writeSpecArtifact(
      tmp,
      "validation/critical-coverage.md",
      [
        "| finding | test | verdict |",
        "|---------|------|---------|",
        "| P-01 | test_key_absent_from_denial_log | covered |",
      ].join("\n")
    );
    assert.ok(e.advancePhase(7).ok, "an answer per critical unblocks it");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("no critical in the matrix means nothing to answer for", () => {
  const { engine: e, tmp } = engineAt(6);
  try {
    // Same matrix minus the 🔴 row: the gate must not invent an obligation.
    writeCoverageMatrix(tmp, [
      "## Iteração 1 — V(1)",
      "",
      "| id | module | lens | severity | description |",
      "|----|--------|------|----------|-------------|",
      "| P-02 | store | Assumptions | 🟡 | assumes the counter never wraps |",
    ].join("\n"));
    e.recordTestOutcome("pytest", "pass");
    markAll(e, 6);
    assert.ok(e.advancePhase(7).ok);
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("numbered premises are answered; prose premises are not demanded", () => {
  const { engine: e, tmp } = engineAt(6);
  try {
    writeCoverageMatrix(tmp, [
      "## Iteração 1 — V(1)",
      "",
      "| id | module | lens | severity | description |",
      "|----|--------|------|----------|-------------|",
      "| P-02 | store | Assumptions | 🟡 | assumes the counter never wraps |",
    ].join("\n"));
    e.recordTestOutcome("pytest", "pass");
    markAll(e, 6);

    // Prose premises: no id to check, so the gate stays quiet rather than
    // imposing a numbering convention half the corpus never agreed to.
    writeArchitectureDoc(tmp, MODULE_TABLE + "\n\nWe assume the clock is monotonic.");
    assert.ok(e.advancePhase(7).ok, "prose premises must not block");

    // Numbered premises: now there is something to point at.
    (e.getPhaseState() as any).currentPhase = 6;
    writeArchitectureDoc(tmp, MODULE_TABLE + "\n\nA-1: the clock is monotonic.\nA-2: keys are opaque.");
    const blocked = e.advancePhase(7);
    assert.ok(!blocked.ok, "an id the design leaned on must be answered");
    if (!blocked.ok) {
      const msg = blocked.error.missingCriteria.join(" ");
      assert.ok(msg.includes("premise-coverage.md"));
      assert.ok(msg.includes("A-1") && msg.includes("A-2"));
    }

    writeSpecArtifact(tmp, "validation/premise-coverage.md",
      "A-1: checked by test_clock_never_goes_back.\nA-2: not checkable — keys come from the caller.");
    assert.ok(e.advancePhase(7).ok);
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("the nine widened triggers are the ones rendered", () => {
  const g = getCompleteGuidance();
  // Each of the nine states the condition its own central question implies, with
  // the examples demoted — that is what stopped estimators reading the narrow list
  // as the requirement.
  const marks = [
    "outside its own process that can fail, stall",           // Resilience
    "existing, relied-upon state or contract across a change", // Migration
    "consequential decision whose effect falls on people",     // Ethical
    "states, handoffs, or exception paths",                    // Process
    "would need to tell WHY without changing code",            // Observability
    "regulates state over time rather than only reacting",     // Control
    "a self-interested one could deviate",                     // Game Theory
    "two correct readings could diverge",                      // Linguistics
    "depends on something that can vary",                      // Mechanical
  ];
  for (const m of marks) assert.ok(g.includes(m), `missing trigger text: ${m}`);
  // The three from 0.7.3 are untouched.
  assert.ok(g.includes("Any surface a PERSON operates"));
  assert.ok(g.includes("whose cost grows with use"));
  assert.ok(g.includes("This is a SYSTEM property"));
});

test("Phase 6 guidance asks for the two coverage files, Phase 1 for numbered premises", () => {
  const g = getCompleteGuidance();
  assert.ok(g.includes("specs/validation/critical-coverage.md"));
  assert.ok(g.includes("specs/validation/premise-coverage.md"));
  assert.ok(g.includes("Number the premises the design leans on"));
  assert.ok(g.includes("COMPLETE module table, not a delta"));
  // Part IV, the practices that were already spontaneous.
  assert.ok(g.includes("A micro-check is something you RUN"));
  assert.ok(g.includes("Measure per stage before optimizing"));
  assert.ok(g.includes("which scenario it builds"));
});

test("an exit status decides the outcome, whatever language the output is in", () => {
  engine.initProject("exit", "agnostic");
  // Output in Portuguese: no English marker would match, and none needs to.
  let res = JSON.parse(handleRecordTestOutcome(engine, {
    command: 'npm test; echo "VERSUS_TEST_EXIT=$?"',
    exit_code: 0,
  } as any));
  assert.strictEqual(res.recorded, "pass");
  const t = engine.getPhaseState()!.lastTestOutcome!;
  assert.strictEqual(t.provenance!.exitCode, 0);
  assert.strictEqual(t.provenance!.exitSource, "echo");

  res = JSON.parse(handleRecordTestOutcome(engine, { command: "pytest", exit_code: 1 } as any));
  assert.strictEqual(res.recorded, "failure");
  assert.strictEqual(engine.getPhaseState()!.lastTestOutcome!.outcome, "fail");
});

test("the exit status outranks a contradictory outcome field", () => {
  engine.initProject("exit", "precedence");
  // A model that says 'pass' while $? said 1 is reporting its reading, not the
  // run. The number wins: it is the only signal that does not depend on reading.
  handleRecordTestOutcome(engine, { command: "pytest", exit_code: 1, outcome: "pass" } as any);
  assert.strictEqual(engine.getPhaseState()!.lastTestOutcome!.outcome, "fail");
});

test("a pass via exit status is nominal; one read off the output is not", () => {
  const { engine, tmp } = engineAt(6);
  try {
    handleRecordTestOutcome(engine, { command: "npm test", exit_code: 0 } as any);
    markAll(engine, 6);
    assert.ok(engine.advancePhase(7).ok);
    const v = engine
      .getPhaseState()!
      .exitCriteria.find((c) => c.phase === 6 && c.criterion === "tests_passing")!.verifiedBy!;
    assert.strictEqual(v.nominal, true, "an exit status of 0 is the strong path");
    assert.strictEqual(v.path, "test-pass/exit-echo");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("the refusal teaches the echo, so the next run is classifiable", () => {
  const { engine, tmp } = engineAt(6);
  try {
    markAll(engine, 6);
    const blocked = engine.advancePhase(7);
    assert.ok(!blocked.ok);
    if (!blocked.ok) {
      const msg = blocked.error.missingCriteria.join(" ");
      assert.ok(msg.includes("VERSUS_TEST_EXIT=$?"), "the first refusal must correct the habit");
      assert.ok(msg.includes("exit_code"));
    }
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("the guidance makes the echo the standard invocation", () => {
  const g = getCompleteGuidance();
  assert.ok(g.includes('npm test; echo "VERSUS_TEST_EXIT=$?"'));
  assert.ok(g.includes("Never modify the test runner"), "the antipattern must be named");
});


console.log("\n=== Guidance Delivery Tests ===\n");

test("get_phase_state reports safeguards LIVE, not the cached status", () => {
  const { engine: e, tmp } = engineInPhase5();
  try {
    for (let i = 0; i < LOOP_FAILURE_THRESHOLD; i++) e.recordTestOutcome("npm test", "fail");

    // The stored field is only written by check_all_safeguards, which nothing
    // here called — so it still says the safeguard is fine.
    const cached = e.getPhaseState()!.safeguards.find((s) => s.id === "S6")!;
    assert.strictEqual(cached.status, "ok", "the cached field is stale by design");

    // And S6 is in fact vetoing the next transition right now.
    assert.ok(!e.advancePhase(6).ok, "S6 is blocking");

    const out = JSON.parse(handleGetPhaseState(e));
    const s6 = out.safeguards.find((x: { id: string }) => x.id === "S6");
    assert.strictEqual(s6.status, "violated", "what is reported must be what is enforced");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("a named diagnosis clears the violation in the panel too", () => {
  const { engine: e, tmp } = engineInPhase5();
  try {
    for (let i = 0; i < LOOP_FAILURE_THRESHOLD; i++) e.recordTestOutcome("npm test", "fail");
    const before = JSON.parse(handleGetPhaseState(e));
    assert.strictEqual(before.safeguards.find((x: { id: string }) => x.id === "S6").status, "violated");

    e.recordDecision(5, "diagnosis", "the fixture rebuilt state between runs");

    // Back to `warning`, not `ok`: in Phase 5 S6 always carries the standing
    // "implementation active" advisory. What matters is that it stops being a
    // violation the moment the escape is taken — with nobody recording anything.
    const after = JSON.parse(handleGetPhaseState(e));
    assert.strictEqual(after.safeguards.find((x: { id: string }) => x.id === "S6").status, "warning");

    // And the veto really is lifted: what blocks now is the unmet criteria, not S6.
    const blocked = e.advancePhase(6);
    assert.ok(!blocked.ok);
    if (!blocked.ok) {
      assert.deepStrictEqual(blocked.error.safeguardViolations, [], "S6 no longer vetoes");
    }
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("the emission budget is a global rule, and it arrives first", () => {
  // The host aborts one request at 60 s mid-stream; at ~37 t/s that is ~2000
  // tokens. A rule the model never reads cannot prevent that, so it must be in
  // the part that always arrives inline.
  for (const phase of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const parts = splitGuidance(getFullGuidance(phase));
    assert.ok(parts[0].includes("R6: Emission budget"), `phase ${phase} carries R6 in part 1`);
  }
  const g = getFullGuidance(2);
  assert.ok(g.includes(String(EMISSION_BUDGET_TOKENS)), "the budget is stated as a number");
  assert.ok(g.includes("PER REQUEST"), "the reason the split is cheap must be stated");
});

test("R6 does not weaken R5 — complete, in blocks", () => {
  const g = getFullGuidance(2);
  assert.ok(/complete table is still mandatory/.test(g));
  assert.ok(/never summarized, never truncated/.test(g));
  // And the phase that actually crosses the budget says so where it happens.
  assert.ok(g.includes("findings 1-30 of 47"), "Phase 2 shows how to announce a split");
});

test("without an ask-user tool the questions stay chat blocks", () => {
  const g = getFullGuidance(0);
  assert.ok(g.includes("asked directly in chat"));
  assert.ok(g.includes("Reply with the number"), "the reply line is what invites an answer");
  assert.ok(g.includes("STOP your turn and wait"), "prose only stops a model that chooses to stop");
});

test("with an ask-user tool the questions go through it", () => {
  const g = getFullGuidance(0, { askUserTool: "ask_user" });
  assert.ok(g.includes("call `ask_user`"), "the tool must be named");
  assert.ok(!g.includes("Reply with the number"), "the chat-only reply line does not belong here");
  // The option shape survives: only the delivery changes, not what is asked.
  assert.ok(g.includes("**Option A (Recommended)**"));
  assert.ok(g.includes("fall back to writing the block above"), "a missing tool must not dead-end");
});

test("the ask-user rule is in the part that always arrives", () => {
  // R2 is a global rule, so it is in part 1 — the only part a model that ignores
  // the chain will ever read, and the one that must carry how to ask.
  for (const phase of [0, 2, 4, 6]) {
    const parts = splitGuidance(getFullGuidance(phase, { askUserTool: "ask_user" }));
    assert.ok(parts[0].includes("call `ask_user`"), `phase ${phase} carries it in part 1`);
  }
});

test("the tool name comes from the host, not from the model name", () => {
  // Whatever the host calls it, that is what gets taught — no allowlist to go stale.
  const g = getFullGuidance(1, { askUserTool: "prompt_the_human" });
  assert.ok(g.includes("call `prompt_the_human`"));
});

test("the parts reassemble into exactly the whole guidance", () => {
  // The invariant that matters: splitting is a delivery change, not an edit.
  // Nothing may be dropped, duplicated, or reordered on the way out.
  for (const phase of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const whole = getFullGuidance(phase);
    assert.strictEqual(splitGuidance(whole).join("\n"), whole, `phase ${phase} round-trips`);
  }
});

test("every part fits inside the host's inline limit", () => {
  // Measured on this host: 5691 chars arrived inline, 8377 was written to a
  // session-resource file instead. A part above that never reaches the model.
  const MEASURED_INLINE_OK = 5691;
  for (const phase of [0, 1, 2, 3, 4, 5, 6, 7]) {
    for (const part of splitGuidance(getFullGuidance(phase))) {
      assert.ok(
        part.length <= MEASURED_INLINE_OK,
        `phase ${phase} has a ${part.length}-char part; it would be externalized`
      );
    }
  }
});

test("a part never begins mid-sentence", () => {
  // Parts break on headings and bold openers, so a table keeps its header row
  // and no part opens halfway through a paragraph.
  for (const phase of [0, 1, 2, 3, 4, 5, 6, 7]) {
    for (const part of splitGuidance(getFullGuidance(phase))) {
      assert.ok(/^(#{1,4} |\*\*)/.test(part), `phase ${phase}: part starts with "${part.slice(0, 40)}"`);
    }
  }
});

test("every part but the last demands the next one", () => {
  const { engine: e, tmp } = engineAt(2);
  try {
    const first = JSON.parse(handleGetPhaseGuidance(e, { phase: 2 }));
    assert.strictEqual(first.part, 1, "an omitted part means the first");
    assert.ok(first.totalParts > 1);

    for (let p = 1; p < first.totalParts; p++) {
      const r = JSON.parse(handleGetPhaseGuidance(e, { phase: 2, part: p }));
      assert.ok(r._nextAction.includes(`part=${p + 1}`), `part ${p} must chain to ${p + 1}`);
    }
    const last = JSON.parse(handleGetPhaseGuidance(e, { phase: 2, part: first.totalParts }));
    assert.strictEqual(last._nextAction, undefined, "the last part is the end of the chain");
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("a part out of range says what the range is", () => {
  const { engine: e, tmp } = engineAt(2);
  try {
    const r = JSON.parse(handleGetPhaseGuidance(e, { phase: 2, part: 99 }));
    assert.ok(r.error.includes("does not exist"));
    assert.ok(r.error.includes(`1..${r.totalParts}`), "a refusal must name the valid range");
  } finally {
    cleanTempWorkspace(tmp);
  }
});


console.log("\n=== VRAM Sizing Tests ===\n");

/** qwen3.8:27b, as /api/show publishes it. */
const QWEN_INFO = {
  "qwen35.block_count": 64,
  "qwen35.attention.head_count_kv": 4,
  "qwen35.attention.key_length": 256,
  "qwen35.full_attention_interval": 4,
};

test("the KV cost per token matches what llama.cpp reports", () => {
  // Measured on this model at 65536 tokens with q8_0: 2176 MiB.
  const per = kvMiBPerToken(QWEN_INFO, "q8_0")!;
  const at64k = per * 65536;
  assert.ok(Math.abs(at64k - 2176) < 20, `formula says ${at64k.toFixed(0)} MiB, llama.cpp says 2176`);
});

test("only the full-attention layers pay for the cache", () => {
  // 64 blocks at interval 4 means 16 layers hold a KV cache, so the window is
  // four times cheaper here than the usual formula predicts. Missing this would
  // make every suggestion far too small.
  const hybrid = kvMiBPerToken(QWEN_INFO, "q8_0")!;
  const uniform = kvMiBPerToken({ ...QWEN_INFO, "qwen35.full_attention_interval": 1 }, "q8_0")!;
  assert.ok(Math.abs(uniform / hybrid - 4) < 0.01, "the interval must divide the layer count");
});

test("the cache type scales the cost", () => {
  const q8 = kvMiBPerToken(QWEN_INFO, "q8_0")!;
  assert.ok(Math.abs(kvMiBPerToken(QWEN_INFO, "q4_0")! / q8 - 0.5) < 0.01);
  assert.ok(Math.abs(kvMiBPerToken(QWEN_INFO, "f16")! / q8 - 2) < 0.01);
  assert.strictEqual(kvMiBPerToken(QWEN_INFO, undefined)!, kvMiBPerToken(QWEN_INFO, "f16")!);
});

test("an incomplete model_info yields no number rather than a wrong one", () => {
  assert.strictEqual(kvMiBPerToken(undefined, "q8_0"), null);
  assert.strictEqual(kvMiBPerToken({ "x.block_count": 64 }, "q8_0"), null);
});

test("the suggestion reproduces the 4090 that was measured", () => {
  // 19/08, before this machine's card was replaced: 24564 MiB total, the model
  // loaded at 65536, and 1846 MiB free with the desktop up. 65536 leaves less
  // than the margin, so the honest answer is a smaller window.
  const fit = fitWindow({
    totalMiB: 24564,
    freeMiB: 1846,
    anchorWindow: 65536,
    kvMiBPerToken: kvMiBPerToken(QWEN_INFO, "q8_0")!,
    headroomMiB: DEFAULT_HEADROOM_MIB,
  })!;
  assert.strictEqual(fit.numCtx, 49152);
  assert.ok(fit.freeAtWindowMiB >= DEFAULT_HEADROOM_MIB);
  assert.ok(fit.explanation.includes("24564 MiB on the card"), "the arithmetic must be shown");
});

test("a roomy card is still capped by the model's architecture", () => {
  const per = kvMiBPerToken(QWEN_INFO, "q8_0")!;
  const uncapped = fitWindow({
    totalMiB: 32607, freeMiB: 30930, anchorWindow: 65536, kvMiBPerToken: per,
    headroomMiB: DEFAULT_HEADROOM_MIB,
  })!;
  assert.strictEqual(uncapped.numCtx, 262144);

  const capped = fitWindow({
    totalMiB: 32607, freeMiB: 30930, anchorWindow: 65536, kvMiBPerToken: per,
    headroomMiB: DEFAULT_HEADROOM_MIB, maxWindow: 131072,
  })!;
  assert.strictEqual(capped.numCtx, 131072, "nothing above the architectural max is offerable");
});

test("a card with no room to spare gets no suggestion", () => {
  // Better to say nothing than to propose a window that will spill to CPU.
  const fit = fitWindow({
    totalMiB: 12288,
    freeMiB: 200,
    anchorWindow: 4096,
    kvMiBPerToken: kvMiBPerToken(QWEN_INFO, "q8_0")!,
    headroomMiB: DEFAULT_HEADROOM_MIB,
  });
  assert.strictEqual(fit, null);
});


console.log("\n=== State Snapshot Delivery Tests ===\n");

test("the state snapshot stays inside the host's inline limit", () => {
  // Measured on this host: 5691 chars arrived inline, 8377 was written to a
  // session-resource file instead. get_phase_state is the gateway guard — the
  // one call the model is told to make first — so a snapshot that lands on disk
  // loses the project's state, silently.
  engine.initProject("big", "a project that ran long");
  for (let i = 0; i < 80; i++) {
    engine.recordDecision(i % 8, "architecture", `decision ${i}: ${"x".repeat(400)}`);
  }
  engine.updateProjectSpec({
    stack: Array.from({ length: 40 }, (_, i) => `stack item ${i} ${"y".repeat(60)}`),
    constraints: Array.from({ length: 40 }, (_, i) => `constraint ${i} ${"z".repeat(60)}`),
  });

  const out = handleGetPhaseState(engine);
  assert.ok(out.length <= 5691, `snapshot is ${out.length} chars; it would be externalized`);
});

test("what was left out is said, with where to find it", () => {
  engine.initProject("big", "long");
  for (let i = 0; i < 40; i++) {
    engine.recordDecision(0, "scope", `decision ${i}: ${"x".repeat(500)}`);
  }
  const out = JSON.parse(handleGetPhaseState(engine));
  assert.ok(out._decisionsNote.includes("get_decisions"), "point at the full text");
  assert.ok(out._decisionsNote.includes("40 are on record"), "say how many exist");
  assert.ok(out.recentDecisions.length >= 1, "at least the newest survives");
});

test("a small project loses nothing", () => {
  engine.initProject("small", "short");
  engine.recordDecision(0, "scope", "out of scope: i18n");
  engine.updateProjectSpec({ stack: ["TypeScript"] });
  const out = JSON.parse(handleGetPhaseState(engine));
  assert.strictEqual(out.recentDecisions.length, 1);
  assert.strictEqual(out._decisionsNote, undefined, "no note when nothing was dropped");
  assert.strictEqual(out._specNote, undefined);
  assert.deepStrictEqual(out.projectSpec.stack, ["TypeScript"], "values, not stamped entries");
});

test("the spec reaches the model as values, and the stamps stay on disk", () => {
  // The {value, phase, at} shape exists so an external analysis can date the
  // spec from state.json; the stamp costs ~50 chars an entry and the model never
  // reads it. Five kilobytes of metadata across a hundred entries.
  engine.initProject("spec", "stamps");
  engine.updateProjectSpec({ stack: ["TypeScript", "Node 18+"] });
  const out = JSON.parse(handleGetPhaseState(engine));
  assert.deepStrictEqual(out.projectSpec.stack, ["TypeScript", "Node 18+"]);
  const stored = engine.getPhaseState()!.projectSpec.stack[0] as { value: string; at: string };
  assert.ok(stored.at, "the stamp is still on disk where the analysis reads it");
});

test("no spec list is starved out by a longer one", () => {
  // A proportional share, floored: a project with 200 stack entries must not
  // push its constraints out of the snapshot entirely.
  const many = Array.from({ length: 200 }, (_, i) => `stack ${i} ${"y".repeat(40)}`);
  engine.initProject("skew", "one huge list");
  engine.updateProjectSpec({ stack: many, constraints: ["local model only", "no cloud fallback"] });
  const out = JSON.parse(handleGetPhaseState(engine));
  assert.ok(out.projectSpec.constraints.length > 0, "the short list must still appear");
  assert.ok(out._specNote.includes("not shown"));
});

test("a decision long enough to fill the budget is shortened, not dropped", () => {
  const one = [{ phase: 0, category: "scope", content: "x".repeat(5000) }];
  const fit = fitDecisions(one, 2048);
  assert.strictEqual(fit.kept.length, 1, "the newest decision always survives");
  assert.strictEqual(fit.shortened, 1);
  assert.ok(fit.kept[0].content.endsWith("[truncated]"), "and says it was cut");
});

console.log("\n=== All tests completed ===\n");
