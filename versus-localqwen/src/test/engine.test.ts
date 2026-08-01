// State Engine and Methodology Rules tests

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { StateEngine, LOOP_FAILURE_THRESHOLD } from "../state/engine";
import { ScoreBreakdown } from "../state/types";
import { getCompleteGuidance } from "../rules/full-guidance";
import { withNumCtx } from "../ollama/align";
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
    assert.ok(result.error.missingCriteria.length > 0);
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
});

test("loop Phase 2↔3 allowed", () => {
  engine.initProject("Test", "Desc");
  // Fast-forward to Phase 2
  engine.updateScore(95, makeFullBreakdown(95));
  for (const c of engine.getExitCriteriaWithDefs(0)) engine.markExitCriterion(0, c.criterion, true);
  engine.advancePhase(1);
  for (const c of engine.getExitCriteriaWithDefs(1)) engine.markExitCriterion(1, c.criterion, true);
  engine.advancePhase(2);

  assert.strictEqual(engine.getPhaseState()!.currentPhase, 2);

  // Phase 2 → 3
  for (const c of engine.getExitCriteriaWithDefs(2)) engine.markExitCriterion(2, c.criterion, true);
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

test("withNumCtx appends after the last PARAMETER", () => {
  const out = withNumCtx("FROM /blob\nTEMPLATE x\nPARAMETER temperature 1\n", 65536);
  assert.strictEqual(numCtxCount(out), 1);
  assert.ok(out.includes("PARAMETER temperature 1\nPARAMETER num_ctx 65536"));
});

test("withNumCtx replaces an existing value and collapses duplicates", () => {
  const replaced = withNumCtx("FROM /blob\nPARAMETER num_ctx 4096\nPARAMETER top_k 20\n", 65536);
  assert.strictEqual(numCtxCount(replaced), 1);
  assert.ok(replaced.includes("num_ctx 65536"));
  assert.ok(replaced.includes("top_k 20"), "unrelated parameters must survive");

  const deduped = withNumCtx("FROM /blob\nPARAMETER num_ctx 1\nPARAMETER num_ctx 2\n", 65536);
  assert.strictEqual(numCtxCount(deduped), 1);
});

test("withNumCtx preserves RENDERER, PARSER and LICENSE", () => {
  const src = "# c\nFROM /b\nRENDERER qwen3.5\nPARSER qwen3.5\nPARAMETER top_p 0.95\nLICENSE \"\"\"t\"\"\"\n";
  const out = withNumCtx(src, 65536);
  assert.ok(out.includes("RENDERER qwen3.5"));
  assert.ok(out.includes("PARSER qwen3.5"));
  assert.ok(out.includes("LICENSE"));
  assert.strictEqual(numCtxCount(out), 1);
});

test("withNumCtx refuses a modelfile with no anchor", () => {
  assert.throws(() => withNumCtx("LICENSE only", 65536));
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
    assert.ok(ok.guidance.includes("BOOTSTRAP PROTOCOL"));
    assert.ok(ok.guidance.includes("SURFACE files only"));

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
    assert.strictEqual(engine.recordTestOutcome("pytest tests/", true).count, 1);
    assert.strictEqual(engine.recordTestOutcome("pytest tests/", true).count, 2);
    // The green run is the end of the work, never a loop. Counting it would make
    // S4 (execute and verify) impossible to satisfy.
    assert.strictEqual(engine.recordTestOutcome("pytest tests/", false).count, 0);
    assert.ok(!engine.isLoopBlocked());
  } finally {
    cleanTempWorkspace(tmp);
  }
});

test("three undiagnosed failures violate S6", () => {
  const { engine, tmp } = engineInPhase5();
  try {
    for (let i = 0; i < LOOP_FAILURE_THRESHOLD; i++) {
      engine.recordTestOutcome("pytest tests/test_tasks.py", true);
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
      engine.recordTestOutcome("pytest tests/", true);
    }
    assert.ok(engine.isLoopBlocked());

    engine.recordDecision(5, "diagnosis", "to_dict() drops the tags relation on M:N");
    assert.ok(!engine.isLoopBlocked(), "a named cause must clear the block");
    assert.strictEqual(engine.checkSafeguard("S6").status, "warning");

    // Aliases must work too, and an unrelated category must not clear it.
    engine.recordTestOutcome("pytest tests/", true);
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
    engine.recordTestOutcome("npm test -- consent", true);
    engine.recordTestOutcome("npm test -- link", true);
    engine.recordTestOutcome("npm test -- export", true);
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
      engine.recordTestOutcome("pytest tests/", true);
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

console.log("\n=== All tests completed ===\n");
