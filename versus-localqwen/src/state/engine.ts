// State Engine — manages persistent methodology state

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import {
  PhaseState,
  Decision,
  ExitCriterionState,
  ScoreBreakdown,
  SpecsStatus,
  TransitionError,
  IterationInfo,
  Result,
  createDefaultState,
  SafeguardState,
} from "./types";

import { isValidTransition, getExitCriteriaForPhase, CRITERION_ID_MIGRATION } from "../rules/phases";
import {
  SafeguardResult,
  validateSafeguard,
  getSafeguardsForPhase,
  LOOP_FAILURE_THRESHOLD,
  DIAGNOSIS_CATEGORIES,
} from "../rules/safeguards";

export { LOOP_FAILURE_THRESHOLD, DIAGNOSIS_CATEGORIES };

interface ValidationResult {
  valid: boolean;
  missingCriteria: string[];
  specsWarnings: string[];
  safeguardViolations: string[];
}

function validatePhaseTransition(
  from: number,
  to: number,
  state: PhaseState,
  exitCriteriaMet: Map<string, boolean>
): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    missingCriteria: [],
    specsWarnings: [],
    safeguardViolations: [],
  };

  if (!isValidTransition(from, to)) {
    result.valid = false;
    result.missingCriteria.push(
      `Transition from Phase ${from} to Phase ${to} is not allowed. Valid transitions: sequential or loop 2↔3.`
    );
    return result;
  }

  if (to > from) {
    const criteria = getExitCriteriaForPhase(from);
    for (const criterion of criteria) {
      if (criterion.required && !exitCriteriaMet.get(criterion.criterion)) {
        result.valid = false;
        result.missingCriteria.push(
          `[Phase ${from}] ${criterion.criterion}: ${criterion.description}`
        );
      }
    }
  }

  if (from === 0 && to === 1) {
    if (state.phase0Score === null || state.phase0Score < 90) {
      result.valid = false;
      result.missingCriteria.push(
        `Phase 0 score = ${state.phase0Score ?? "null"}. Required >= 90.`
      );
    }
  }

  const safeguards = getSafeguardsForPhase(from);
  for (const safeguard of safeguards) {
    const check = validateSafeguard(safeguard.id, state);
    if (check.status === "violated") {
      result.valid = false;
      result.safeguardViolations.push(`${safeguard.id}: ${check.details}`);
    }
  }

  return result;
}

export class StateEngine {
  private state: PhaseState | null = null;
  private statePath: string;
  private specsPath: string;

  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.statePath = path.join(workspacePath, ".versus", "state.json");
    this.specsPath = path.join(workspacePath, "specs");
  }

  getWorkspace(): string {
    return this.workspacePath;
  }

  // --- Lifecycle ---

  load(): PhaseState | null {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, "utf-8");
        this.state = JSON.parse(raw) as PhaseState;
        if (this.migrateCriterionIds()) {
          this.save();
        }
        return this.state;
      }
    } catch (err) {
      // state.json corrupted — return null
    }
    return null;
  }

  /** Migrates Portuguese criterion IDs to English. Returns true if any were migrated. */
  private migrateCriterionIds(): boolean {
    if (!this.state) return false;
    let migrated = false;
    for (const ec of this.state.exitCriteria) {
      const newId = CRITERION_ID_MIGRATION[ec.criterion];
      if (newId) {
        ec.criterion = newId;
        migrated = true;
      }
    }
    for (const h of this.state.history) {
      if (h.criteriaMet) {
        h.criteriaMet = h.criteriaMet.map((c) => CRITERION_ID_MIGRATION[c] || c);
      }
    }
    return migrated;
  }

  private save(): void {
    if (!this.state) return;
    this.state.updatedAt = new Date().toISOString();
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf-8");
  }

  // --- Project ---

  initProject(name: string, description: string): PhaseState {
    this.state = createDefaultState(name, description);
    this.save();
    return this.state;
  }

  // --- Gateway Guard ---

  touchPhaseStateCheck(): void {
    if (!this.state) return;
    this.state.lastPhaseStateCheck = new Date().toISOString();
    this.save();
  }

  isContextStale(thresholdMinutes = 30): boolean {
    if (!this.state) return true;
    if (!this.state.lastPhaseStateCheck) return true;
    const last = new Date(this.state.lastPhaseStateCheck).getTime();
    return (Date.now() - last) > thresholdMinutes * 60 * 1000;
  }

  // --- Query ---

  getPhaseState(): PhaseState | null {
    if (!this.state) this.load();
    return this.state;
  }

  getDecisions(phase?: number): Decision[] {
    if (!this.state) return [];
    if (phase !== undefined) {
      return this.state.decisions.filter((d) => d.phase === phase);
    }
    return this.state.decisions;
  }

  getExitCriteriaState(phase: number): ExitCriterionState[] {
    if (!this.state) return [];
    return this.state.exitCriteria.filter((c) => c.phase === phase);
  }

  getExitCriteriaWithDefs(phase: number): Array<{ criterion: string; description: string; met: boolean; details?: string }> {
    const defs = getExitCriteriaForPhase(phase);
    const states = this.getExitCriteriaState(phase);
    return defs.map((def) => {
      const state = states.find((s) => s.criterion === def.criterion);
      return {
        criterion: def.criterion,
        description: def.description,
        met: state?.met ?? false,
        details: state?.details,
      };
    });
  }

  // --- Transitions ---

  advancePhase(targetPhase: number): Result<void, TransitionError> {
    if (!this.state) {
      return { ok: false, error: { message: "Project not initialized.", missingCriteria: [] } };
    }

    const from = this.state.currentPhase;
    const exitCriteriaMet = new Map<string, boolean>();
    for (const c of this.state.exitCriteria) {
      if (c.phase === from) {
        exitCriteriaMet.set(c.criterion, c.met);
      }
    }

    const validation = validatePhaseTransition(from, targetPhase, this.state, exitCriteriaMet);

    // Check specs/ (warning, doesn't block)
    const specsWarnings: string[] = [];
    if (targetPhase >= 1) {
      const specsStatus = this.checkSpecsStatus();
      const expectedDirs = this.getExpectedSpecsDirs(from);
      for (const dir of expectedDirs) {
        if (specsStatus[dir] && !specsStatus[dir].populated) {
          specsWarnings.push(`specs/${dir}/ is empty (expected before Phase ${targetPhase})`);
        }
      }
    }

    const artifactMissing = this.missingEvidence(from);

    if (!validation.valid || artifactMissing.length > 0) {
      return {
        ok: false,
        error: {
          message: `Cannot advance from Phase ${from} to Phase ${targetPhase}.`,
          missingCriteria: [...validation.missingCriteria, ...artifactMissing],
          specsWarnings,
          // A violated safeguard vetoes the transition on its own. Dropping it
          // here left the caller with an empty reason and no way to act.
          safeguardViolations: validation.safeguardViolations,
        },
      };
    }

    // Valid transition
    this.state.history.push({
      from,
      to: targetPhase,
      timestamp: new Date().toISOString(),
      criteriaMet: Array.from(exitCriteriaMet.entries())
        .filter(([, met]) => met)
        .map(([criterion]) => criterion),
    });

    this.state.currentPhase = targetPhase;
    this.state.currentIteration = 1;
    this.state.loopCounter = { pattern: "", count: 0, firstSeen: "", lastSeen: "" };
    this.save();

    // Returns OK with specs warnings if any
    return { ok: true, value: undefined };
  }

  startIteration(phase: number): Result<IterationInfo, string> {
    if (!this.state) {
      return { ok: false, error: "Project not initialized." };
    }
    if (this.state.currentPhase !== phase) {
      return { ok: false, error: `Current phase is ${this.state.currentPhase}, not ${phase}.` };
    }

    this.state.currentIteration += 1;
    this.save();

    return {
      ok: true,
      value: {
        phase,
        iterationNumber: this.state.currentIteration,
      },
    };
  }

  // --- Recording ---

  recordDecision(phase: number, category: string, content: string): Decision {
    if (!this.state) throw new Error("Project not initialized.");

    const decision: Decision = {
      id: randomUUID(),
      phase,
      category,
      content,
      timestamp: new Date().toISOString(),
    };

    this.state.decisions.push(decision);
    this.save();

    // A named diagnosis clears the S6 counter: the failures are understood.
    if (DIAGNOSIS_CATEGORIES.includes(category.trim().toLowerCase())) {
      this.clearLoopCredit();
    }

    return decision;
  }

  updateProjectSpec(spec: Partial<{ stack: string[]; outOfScope: string[]; patterns: string[]; constraints: string[] }>): void {
    if (!this.state) throw new Error("Project not initialized.");
    if (!this.state.projectSpec) {
      this.state.projectSpec = { stack: [], outOfScope: [], patterns: [], constraints: [] };
    }
    const ps = this.state.projectSpec;
    if (spec.stack) ps.stack = dedupe([...ps.stack, ...spec.stack]);
    if (spec.outOfScope) ps.outOfScope = dedupe([...ps.outOfScope, ...spec.outOfScope]);
    if (spec.patterns) ps.patterns = dedupe([...ps.patterns, ...spec.patterns]);
    if (spec.constraints) ps.constraints = dedupe([...ps.constraints, ...spec.constraints]);
    this.save();
  }

  getProjectSpec(): { stack: string[]; outOfScope: string[]; patterns: string[]; constraints: string[] } {
    if (!this.state) throw new Error("Project not initialized.");
    return this.state.projectSpec ?? { stack: [], outOfScope: [], patterns: [], constraints: [] };
  }

  updateScore(score: number, breakdown: ScoreBreakdown): void {
    if (!this.state) throw new Error("Project not initialized.");
    this.state.phase0Score = score;
    this.state.phase0Breakdown = breakdown;
    this.save();
  }

  markExitCriterion(phase: number, criterion: string, met: boolean, details?: string): void {
    if (!this.state) throw new Error("Project not initialized.");

    const existing = this.state.exitCriteria.find(
      (c) => c.phase === phase && c.criterion === criterion
    );

    if (existing) {
      existing.met = met;
      existing.details = details;
    } else {
      this.state.exitCriteria.push({ phase, criterion, met, details });
    }

    this.save();
  }

  // --- Safeguards ---

  checkSafeguard(id: string): SafeguardResult {
    if (!this.state) {
      return { id, status: "ok", details: "Project not initialized." };
    }
    const result = validateSafeguard(id, this.state);

    // Update internal safeguard state
    const sg = this.state.safeguards.find((s) => s.id === id);
    if (sg) {
      sg.status = result.status;
      sg.details = result.details;
      sg.lastChecked = new Date().toISOString();
      this.save();
    }

    return result;
  }

  checkAllSafeguards(): SafeguardResult[] {
    if (!this.state) return [];
    const applicable = getSafeguardsForPhase(this.state.currentPhase);
    const results = applicable.map((s) => validateSafeguard(s.id, this.state!));

    for (const result of results) {
      const sg = this.state.safeguards.find((s) => s.id === result.id);
      if (sg) {
        sg.status = result.status;
        sg.details = result.details;
        sg.lastChecked = new Date().toISOString();
      }
    }
    this.save();

    return results;
  }

  // --- Specs ---

  checkSpecsStatus(): SpecsStatus {
    const dirs = [
      "references", "domain", "technical", "examples",
      "design", "models", "datasets", "validation", "competitors",
    ];

    const status: SpecsStatus = {};
    for (const dir of dirs) {
      const dirPath = path.join(this.specsPath, dir);
      try {
        if (fs.existsSync(dirPath)) {
          const files = fs.readdirSync(dirPath).filter((f) => f !== "README.md");
          status[dir] = { populated: files.length > 0, fileCount: files.length };
        } else {
          status[dir] = { populated: false, fileCount: 0 };
        }
      } catch {
        status[dir] = { populated: false, fileCount: 0 };
      }
    }
    return status;
  }


  /**
   * Whether the artifact a criterion promises actually exists on disk.
   *
   * Marking a criterion met records a claim; this checks the record survived
   * the session and can be inspected later. The 80-character floor rejects an
   * empty file or a lone heading — it is a liveness check, not a quality one,
   * and the guidance says so rather than implying the engine reviews content.
   */
  artifactPresent(relPath: string): boolean {
    try {
      const full = path.join(this.specsPath, relPath);
      if (!fs.existsSync(full)) return false;
      return fs.readFileSync(full, "utf-8").replace(/\s/g, "").length >= 80;
    } catch {
      return false;
    }
  }

  /**
   * Lines in the artifact matching `pattern`. Where structure carries the
   * meaning, existence is not evidence: a severity grid and a findings table are
   * the same file size and only one can be analysed.
   */
  countArtifactRows(relPath: string, pattern: string): number {
    try {
      const full = path.join(this.specsPath, relPath);
      if (!fs.existsSync(full)) return 0;
      const text = fs.readFileSync(full, "utf-8");
      return (text.match(new RegExp(pattern, "gm")) || []).length;
    } catch {
      return 0;
    }
  }

  /** True when a passing run was witnessed in this phase (S4). */
  witnessedTestPass(phase: number): boolean {
    const t = this.state?.lastTestOutcome;
    return !!t && t.outcome === "pass" && t.phase === phase;
  }

  /**
   * Evidence a phase owes beyond its booleans, as messages rather than a flag:
   * a gate that blocks without naming what is missing is a dead end, which is
   * exactly the failure the safeguardViolations fix addressed.
   */
  private missingEvidence(phase: number): string[] {
    const out: string[] = [];
    for (const def of getExitCriteriaForPhase(phase)) {
      if (!def.required) continue;
      if (def.artifact && !this.artifactPresent(def.artifact)) {
        out.push(
          `[Phase ${phase}] ${def.criterion}: required artifact specs/${def.artifact} is missing or ` +
          `empty. Write the structured artifact to disk — marking the criterion met is not enough; ` +
          `the record must survive the session and be inspectable later.`
        );
      } else if (
        def.artifact &&
        def.artifactRows &&
        this.countArtifactRows(def.artifact, def.artifactRows.pattern) < def.artifactRows.count
      ) {
        out.push(
          `[Phase ${phase}] ${def.criterion}: specs/${def.artifact} exists but is not in the ` +
          `required findings-table form — needs at least ${def.artifactRows.count} finding ` +
          `row(s) carrying an id, e.g. 'P-01 | auth | Security | 🔴 | password reaches the log'. ` +
          `A severity-only grid cannot be analysed: each finding needs its own id so overlap can ` +
          `be told from orthogonality. The id must contain a hyphen and the row must keep its ` +
          `pipes — 'P01' and a row without '|' do not count.`
        );
      }
      if (def.verify === "test-pass" && !this.witnessedTestPass(phase)) {
        out.push(
          `[Phase ${phase}] ${def.criterion}: no passing test run was witnessed in this phase. ` +
          `Run the suite and report it with record_test_outcome(command, failed=false) — this host ` +
          `has no hook watching your shell, so an unreported run is an unwitnessed one. S4: never ` +
          `assume tests passed, execute and verify. Marking the criterion met is not enough.`
        );
      }
    }
    return out;
  }

  // --- Loop Counter ---

  /**
   * Records the outcome of a test run. Only FAILURES accumulate: a green run is
   * the end of the work, never a loop, so it clears the counter.
   *
   * The previous design counted executions and blocked past a threshold, which
   * blocked the passing run too — the one moment S4 (execute and verify)
   * explicitly requires. Counting failures instead makes verification
   * unblockable by construction.
   */
  recordTestOutcome(command: string, failed: boolean): { count: number } {
    if (!this.state) return { count: 0 };

    // Witness for the tests_passing gate. Stamped before the branch, since the
    // pass path returns early through resetLoopCounter.
    this.state.lastTestOutcome = {
      outcome: failed ? "fail" : "pass",
      phase: this.state.currentPhase,
      at: new Date().toISOString(),
    };

    if (!failed) {
      this.resetLoopCounter();
      return { count: 0 };
    }

    const normalized = this.normalizeCommandPattern(command);
    const counter = this.state.loopCounter;
    const now = new Date().toISOString();

    if (counter && counter.pattern === normalized && counter.count > 0) {
      counter.count += 1;
      counter.lastSeen = now;
    } else {
      this.state.loopCounter = {
        pattern: normalized,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        lastDiagnosis: counter?.lastDiagnosis,
      };
    }

    this.save();
    return { count: this.state.loopCounter.count };
  }

  /**
   * A named diagnosis was recorded — the failures so far are understood, not
   * blind. Clears the counter and lets the next run through. This is the escape
   * hatch the S6 message promises, and which nothing used to honour.
   */
  clearLoopCredit(): void {
    if (!this.state) return;
    this.state.loopCounter = {
      pattern: "",
      count: 0,
      firstSeen: "",
      lastSeen: "",
      lastDiagnosis: new Date().toISOString(),
    };
    this.save();
  }

  /** True when undiagnosed failures reached the threshold — S6 is violated. */
  isLoopBlocked(): boolean {
    return this.getLoopCounter().count >= LOOP_FAILURE_THRESHOLD;
  }

  resetLoopCounter(): void {
    if (!this.state) return;
    this.state.loopCounter = {
      pattern: "",
      count: 0,
      firstSeen: "",
      lastSeen: "",
      lastDiagnosis: this.state.loopCounter?.lastDiagnosis,
    };
    this.save();
  }

  getLoopCounter(): { pattern: string; count: number; lastDiagnosis?: string } {
    if (!this.state || !this.state.loopCounter) return { pattern: "", count: 0 };
    const c = this.state.loopCounter;
    return { pattern: c.pattern, count: c.count, lastDiagnosis: c.lastDiagnosis };
  }

  /**
   * Normalizes a test command into a pattern. The suite or target argument is
   * kept: S6 speaks of iterations on the same MODULE, so `npm test -- consent`
   * and `npm test -- link` must not collapse into one counter and compound
   * failures from unrelated suites.
   */
  private normalizeCommandPattern(cmd: string): string {
    const trimmed = cmd.trim().toLowerCase();

    let runner = "";
    if (/\b(npm\s+test|npm\s+run\s+test|npx\s+jest|jest|vitest|mocha)\b/.test(trimmed)) runner = "test:js";
    else if (/\b(pytest|python\s+-m\s+pytest|unittest)\b/.test(trimmed)) runner = "test:py";
    else if (/\bcargo\s+test\b/.test(trimmed)) runner = "test:rust";
    else if (/\bgo\s+test\b/.test(trimmed)) runner = "test:go";
    else if (/\bnpm\s+run\s+build\b/.test(trimmed)) runner = "build";
    else if (/\btsc\b/.test(trimmed)) runner = "compile";
    else return trimmed.substring(0, 50);

    // Target = the suite, file or pattern being exercised. Strips flags and the
    // runner words; what remains identifies the module under test.
    const target = trimmed
      .replace(/^.*?\b(npm\s+run\s+test|npm\s+test|npx\s+jest|jest|vitest|mocha|pytest|python\s+-m\s+pytest|unittest|cargo\s+test|go\s+test|npm\s+run\s+build|tsc)\b/, "")
      .replace(/(^|\s)--?[\w-]+(=\S+)?/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return target ? `${runner}:${target}` : runner;
  }

  // --- Meta-iteration (v1.0 → v2.0) ---

  startNewCycle(): Result<{ cycle: number }, string> {
    if (!this.state) {
      return { ok: false, error: "Project not initialized." };
    }
    if (this.state.currentPhase !== 7) {
      return { ok: false, error: `Current phase is ${this.state.currentPhase}. New cycle can only start from Phase 7 (Post-Review).` };
    }

    // Check Phase 7 exit criteria
    const p7Criteria = this.state.exitCriteria.filter((c) => c.phase === 7);
    const unmet = p7Criteria.filter((c) => !c.met);
    if (unmet.length > 0) {
      return { ok: false, error: `Phase 7 exit criteria not met: ${unmet.map((c) => c.criterion).join(", ")}. Complete Post-Review before starting new cycle.` };
    }

    // A new cycle inherits the previous one's lessons, so they must exist on
    // disk rather than only in a conversation that is about to be replaced.
    const missing = this.missingEvidence(7);
    if (missing.length > 0) {
      return { ok: false, error: missing.join(" ") };
    }

    // Count completed cycles from history (how many times we've reached phase 7)
    const cycleCount = this.state.history.filter((h) => h.to === 7).length + 1;

    // Record cycle boundary in history
    this.state.history.push({
      from: 7,
      to: 0,
      timestamp: new Date().toISOString(),
      criteriaMet: p7Criteria.map((c) => c.criterion),
    });

    // Preserve: decisions, projectSpec, history
    // Reset: phase, iteration, score, exit criteria, safeguards, loop counter
    this.state.currentPhase = 0;
    this.state.currentIteration = 1;
    this.state.phase0Score = null;
    this.state.phase0Breakdown = null;
    this.state.exitCriteria = [];
    this.state.safeguards = [
      { id: "S0", status: "ok" },
      { id: "S1", status: "ok" },
      { id: "S2", status: "ok" },
      { id: "S3", status: "ok" },
      { id: "S4", status: "ok" },
      { id: "S5", status: "ok" },
      { id: "S6", status: "ok" },
      { id: "S7", status: "ok" },
    ];
    this.state.loopCounter = { pattern: "", count: 0, firstSeen: "", lastSeen: "" };

    this.save();
    return { ok: true, value: { cycle: cycleCount + 1 } };
  }

  // --- Private helpers ---

  private getExpectedSpecsDirs(phase: number): string[] {
    switch (phase) {
      case 0: return ["references", "domain", "competitors"];
      case 1: return ["technical", "models", "examples"];
      case 5: return ["technical", "examples", "datasets"];
      case 6: return ["datasets", "validation"];
      default: return [];
    }
  }
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
