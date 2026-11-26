// State Engine — manages persistent methodology state

import * as fs from "fs";
import * as path from "path";
import { randomUUID, createHash } from "crypto";
import { VERSUS_VERSION } from "../version";
import { parseShell, TEST_COMMAND_PATTERNS, loadExtraTestPatterns, testRunLocation } from "../shell-parse";
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
  ProjectSpec,
  SpecItem,
  specItemValue,
  LensActivation,
  TestProvenance,
  VerificationProvenance,
  CycleRecord,
  PhaseTransition,
} from "./types";

import { isValidTransition, getExitCriteriaForPhase, getPhaseDefinition } from "../rules/phases";
import {
  ITERATION_MARK,
  LENS_MARKER,
  VERSION_MARK,
  MatrixFinding,
  parseMatrixFindings,
  parseMatrixIterations,
} from "./artifacts";
import {
  CONDITIONAL_LENSES,
  NO_LENS,
  UNIVERSAL_LENSES,
  canonicalLens,
  isConditionalLens,
} from "../rules/lenses";
import {
  SafeguardResult,
  validateSafeguard,
  getSafeguardsForPhase,
  LOOP_FAILURE_THRESHOLD,
  DIAGNOSIS_CATEGORIES,
} from "../rules/safeguards";

export { LOOP_FAILURE_THRESHOLD, DIAGNOSIS_CATEGORIES };

/** Ids come from artifacts, so they are matched as literals, never as patterns. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The three severity levels, as the guidance fixes them. */
const SEVERITIES = ["🔴", "🟡", "🟢"];

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
        return this.state;
      }
    } catch (err) {
      // state.json corrupted — return null
    }
    return null;
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

    // 2→3: matrix modules must exist in the architecture (union of all versions),
    // and every lens column must be a canonical name declared for its round.
    const moduleDrift = from === 2 ? this.moduleTraceabilityErrors() : [];
    const lensErrors = from === 2 ? this.lensColumnErrors() : [];

    // 6→7: Phase 6 re-checks what earlier phases decided — every critical the
    // critique raised, and every premise the architecture numbered.
    const reverify =
      from === 6
        ? [...this.criticalCoverageErrors(), ...this.premiseCoverageErrors(), ...this.testPromiseErrors(), ...this.deviationsErrors()]
        : [];
    // 5→6: the Phase 5 Scope Inventory leaves a record. It was MUST DISPLAY only, and the
    // ESJUD study crossed 5→6 without ever running the formal inventory.
    if (from === 5 && targetPhase === 6) reverify.push(...this.scopeInventoryMissing());

    // Human sign-off on the record: convergence (3→4), the convergence confirmation after
    // the Phase 4 report (4→5) and the test sign-off (6→7) need an approval DECISION of
    // the current pass of the phase, naming who approved. Audits found these gates crossed
    // with only stamped criteria. Presence, not truth: approvedBy is written by the model.
    const approvalMissing =
      (from === 3 && targetPhase === 4) || (from === 4 && targetPhase === 5) || (from === 6 && targetPhase === 7)
        ? this.approvalMissing(from)
        : [];

    if (
      !validation.valid ||
      artifactMissing.length > 0 ||
      moduleDrift.length > 0 ||
      lensErrors.length > 0 ||
      reverify.length > 0 ||
      approvalMissing.length > 0
    ) {
      return {
        ok: false,
        error: {
          message: `Cannot advance from Phase ${from} to Phase ${targetPhase}.`,
          missingCriteria: [
            ...validation.missingCriteria,
            ...artifactMissing,
            ...moduleDrift,
            ...lensErrors,
            ...reverify,
            ...approvalMissing,
          ],
          specsWarnings,
          // A violated safeguard vetoes the transition on its own. Dropping it
          // here left the caller with an empty reason and no way to act.
          safeguardViolations: validation.safeguardViolations,
        },
      };
    }

    // Every gate passed, so the criteria that carry a `verify:` can record HOW.
    // Stamped here rather than at mark time: before this point the evidence had
    // not been checked, and after the commit the phase is no longer `from`.
    this.stampVerificationProvenance(from);

    // Valid transition
    const transition: PhaseTransition = {
      from,
      to: targetPhase,
      timestamp: new Date().toISOString(),
      criteriaMet: Array.from(exitCriteriaMet.entries())
        .filter(([, met]) => met)
        .map(([criterion]) => criterion),
    };
    const fp = this.designFingerprint();
    if (fp.length) transition.artifacts = fp;
    transition.decisionsAt = this.state.decisions.length;
    this.state.history.push(transition);

    this.state.currentPhase = targetPhase;

    /**
     * The iteration counter belongs to the 2↔3 loop, so the loop must not reset
     * it: going back to 2 opens round N+1, and 2→3 stays inside round N (Phase 3
     * writes the V(N+1) that round N+1 will critique). Resetting on every
     * transition made every round "iteration 1", which is the same as having no
     * counter — nothing downstream could tell which architecture a finding was
     * raised against.
     */
    if (from === 3 && targetPhase === 2) {
      this.state.currentIteration += 1;
    } else if (!(from === 2 && targetPhase === 3)) {
      this.state.currentIteration = 1;
    }

    // Backward transition inside the 2↔3 loop (only 3→2 today): every phase from
    // the target up to the one being left will be REDONE against the new design,
    // so reset all their exit criteria — Phase 2 AND Phase 3. A stamp from the
    // previous pass answered the OLD critique; it must not satisfy the gate for
    // the new one. Phase 3's criticals_addressed from iteration 1 says nobody
    // confirmed iteration 2's criticals.
    if (targetPhase < from) {
      this.resetCriteria(targetPhase, from);
    }

    this.state.loopCounter = { pattern: "", count: 0, firstSeen: "", lastSeen: "" };
    this.save();

    // Returns OK with specs warnings if any
    return { ok: true, value: undefined };
  }

  /**
   * Unmarks the exit criteria of phases `lo..hi` inclusive, so the work has to be
   * earned again. Only the booleans reset — the artifacts stay on disk, which is
   * what lets a new round append to the matrix rather than start it over.
   */
  private resetCriteria(lo: number, hi: number): void {
    if (!this.state) return;
    for (const ec of this.state.exitCriteria) {
      if (ec.phase >= lo && ec.phase <= hi) {
        ec.met = false;
        ec.details = undefined;
      }
    }
  }

  startIteration(phase: number): Result<IterationInfo, string> {
    if (!this.state) {
      return { ok: false, error: "Project not initialized." };
    }
    if (this.state.currentPhase !== phase) {
      return { ok: false, error: `Current phase is ${this.state.currentPhase}, not ${phase}.` };
    }

    this.state.currentIteration += 1;
    // Same reason as re-entry through the loop: a new round of Phase 2 is a new
    // critique, so it owes every criterion again, not just the declaration. Only
    // Phase 2 — this call does not change phase, so Phase 3 was never redone.
    if (phase === 2) {
      this.resetCriteria(2, 2);
    }
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

  recordDecision(
    phase: number,
    category: string,
    content: string,
    provenance?: { proposedBy?: string; approvedBy?: string }
  ): Decision {
    if (!this.state) throw new Error("Project not initialized.");

    const decision: Decision = {
      id: randomUUID(),
      phase,
      category,
      content,
      timestamp: new Date().toISOString(),
      cycle: this.currentCycle(),
    };
    const proposedBy = provenance?.proposedBy?.trim();
    const approvedBy = provenance?.approvedBy?.trim();
    if (proposedBy) decision.proposedBy = proposedBy;
    if (approvedBy) decision.approvedBy = approvedBy;

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

    /**
     * New entries are plain strings again (0.15.0). The {value, phase, at} stamp was
     * research instrumentation, read by no gate and never shown to the model. Stamped
     * entries already on disk are kept as they are and read normally. Dedup is by value.
     */
    const merge = (existing: SpecItem[], incoming: string[]): SpecItem[] => {
      const out = [...existing];
      const seen = new Set(out.map((i) => specItemValue(i)));
      for (const value of incoming) {
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(value);
      }
      return out;
    };

    if (spec.stack) ps.stack = merge(ps.stack, spec.stack);
    if (spec.outOfScope) ps.outOfScope = merge(ps.outOfScope, spec.outOfScope);
    if (spec.patterns) ps.patterns = merge(ps.patterns, spec.patterns);
    if (spec.constraints) ps.constraints = merge(ps.constraints, spec.constraints);
    this.save();
  }

  getProjectSpec(): ProjectSpec {
    if (!this.state) throw new Error("Project not initialized.");
    return this.state.projectSpec ?? { stack: [], outOfScope: [], patterns: [], constraints: [] };
  }

  updateScore(score: number, breakdown: ScoreBreakdown): void {
    if (!this.state) throw new Error("Project not initialized.");
    this.state.phase0Score = score;
    this.state.phase0Breakdown = breakdown;
    this.save();
  }

  /** Declares (or replaces) the mechanical check of a criterion. A new declaration clears
   *  any earlier result: the check must be reported as run AFTER it was declared. */
  declareCheck(phase: number, criterion: string, command: string, expect?: string): Result<void, string> {
    if (!this.state) return { ok: false, error: "Project not initialized." };
    const cmd = command.trim();
    if (!cmd) return { ok: false, error: "check_command is empty." };
    const exp = (expect ?? "exit:0").trim();
    if (!/^exit:\d+$/.test(exp) && !/^output:.+/s.test(exp)) {
      return { ok: false, error: `check_expect must be "exit:<n>" or "output:<regex>"; got "${exp}".` };
    }
    if (exp.startsWith("output:")) {
      try { new RegExp(exp.slice(7)); } catch (e) { return { ok: false, error: `check_expect regex is invalid: ${String(e)}` }; }
    }
    let ec = this.state.exitCriteria.find((c) => c.phase === phase && c.criterion === criterion);
    if (!ec) { ec = { phase, criterion, met: false }; this.state.exitCriteria.push(ec); }
    ec.check = { command: cmd, expect: exp, declaredAt: new Date().toISOString() };
    this.save();
    return { ok: true, value: undefined };
  }

  /**
   * The model reports the result of running a declared check (record_check_outcome). The
   * Claude build has a PostToolUse hook witness the command; this host has none, so the
   * report is the model's — exit status from the `VERSUS_EXIT=$?` echo, output pasted.
   * The engine still decides ok/not-ok against the declared expectation, never the model.
   */
  recordCheckOutcome(
    criterion: string,
    output: string,
    exitCode?: number,
    phase?: number
  ): Result<{ criterion: string; phase: number; ok: boolean; expect: string }, string> {
    if (!this.state) return { ok: false, error: "Project not initialized." };
    const p = phase ?? this.state.currentPhase;
    const ec = this.state.exitCriteria.find((c) => c.phase === p && c.criterion === criterion);
    if (!ec?.check) {
      return {
        ok: false,
        error:
          `No check is declared for ${criterion} (Phase ${p}). Declare it first with ` +
          `mark_exit_criterion(phase=${p}, criterion='${criterion}', met=..., check_command='...', check_expect='...').`,
      };
    }
    const ck = ec.check;
    let ok: boolean;
    if (ck.expect.startsWith("exit:")) {
      ok = typeof exitCode === "number" && exitCode === parseInt(ck.expect.slice(5), 10);
    } else {
      // Matched against the output with the exit-echo line removed.
      const body = output.replace(/^.*VERSUS_(?:TEST_)?EXIT=\d+.*$/gm, "").trim();
      try { ok = new RegExp(ck.expect.slice(7), "m").test(body); } catch { ok = false; }
    }
    ck.witnessed = {
      at: new Date().toISOString(),
      ok,
      exitCode,
      outputTail: output.slice(-600),
      outputSha256: createHash("sha256").update(output).digest("hex"),
      source: "mcp-tool",
    };
    this.save();
    return { ok: true, value: { criterion, phase: p, ok, expect: ck.expect } };
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
      // Per line, for the same reason as tableColumn2: a global match can span a
      // newline and swallow the start of the following row, under-counting rows
      // that are plainly there.
      const re = new RegExp(pattern);
      return fs
        .readFileSync(full, "utf-8")
        .split(/\r?\n/)
        .filter((line) => re.test(line)).length;
    } catch {
      return 0;
    }
  }

  /**
   * Which round of the 2↔3 loop is being critiqued.
   *
   * Derived from how many transitions entered Phase 2, floor 1 — the contract the
   * downstream analysis reads, and independent of `currentIteration`, which in
   * other builds resets on every phase change. Here `currentIteration` does track
   * the round, and `start_iteration(2)` can raise it without a transition, so the
   * higher of the two wins: the two mechanisms must never disagree about which
   * round a declaration belongs to.
   */
  critiqueRound(): number {
    if (!this.state) return 1;
    const entries = this.state.history.filter((h) => h.to === 2).length;
    return Math.max(1, entries, this.state.currentIteration);
  }

  /** How many `## V(N)` sections the architecture doc carries, floor 1. */
  architectureVersion(): number {
    const text = this.readArtifact("technical/architecture.md");
    const n = (text.match(/^\s*#{1,6}\s*V\s*\(?\d+\)?\b/gim) || []).length;
    return Math.max(1, n);
  }

  /** The lens declaration for a round, if one was recorded. */
  lensActivation(iteration: number): LensActivation | undefined {
    return this.state?.activatedLenses?.find((a) => a.iteration === iteration);
  }

  /**
   * Records the lens set for the round in progress. Re-recording the same round
   * replaces it — a correction, not a second declaration — while a new round is
   * pushed, because the history is what lets a finding be checked against the set
   * that was in force when it was raised.
   */
  recordActivatedLenses(
    conditional: string[],
    notActivated: { lens: string; reason: string }[]
  ): LensActivation {
    if (!this.state) throw new Error("Project not initialized.");
    const entry: LensActivation = {
      universal: [...UNIVERSAL_LENSES],
      conditional,
      notActivated,
      iteration: this.critiqueRound(),
      againstVersion: this.architectureVersion(),
      recordedAt: new Date().toISOString(),
    };
    if (!this.state.activatedLenses) this.state.activatedLenses = [];
    const at = this.state.activatedLenses.findIndex((a) => a.iteration === entry.iteration);
    if (at >= 0) {
      this.state.activatedLenses[at] = entry;
    } else {
      this.state.activatedLenses.push(entry);
    }
    this.save();
    return entry;
  }

  /**
   * Module names in the 2nd column of table rows whose 1st cell matches
   * `idPattern`. Normalized (trim + lowercase) for comparison.
   */
  private tableColumn2(relPath: string, idPattern: string): Set<string> {
    const out = new Set<string>();
    try {
      const full = path.join(this.specsPath, relPath);
      if (!fs.existsSync(full)) return out;
      // Line by line, anchored. A single global regex over the whole file walks
      // across newlines: a row whose last cell is itself an id — `depends-on`
      // holding `M-01` — matches `| M-01 |\n|` and consumes the pipe that OPENS
      // the next row, so that row is never seen. The effect is silent and
      // selective: the module after a dependency-carrying one disappears while
      // its neighbours resolve, which reads as the gate being inconsistent.
      const re = new RegExp(`^\\s*\\|\\s*(?:${idPattern})\\s*\\|\\s*([^|]+?)\\s*\\|`);
      for (const line of fs.readFileSync(full, "utf-8").split(/\r?\n/)) {
        const m = re.exec(line);
        if (!m) continue;
        const v = m[1].trim().toLowerCase();
        if (v) out.add(v);
      }
    } catch {
      /* never blocks */
    }
    return out;
  }

  /**
   * Drift: every module a finding cites must appear in architecture.md's module
   * table in SOME version (union of all `## V(N)`). Tolerating a removed module
   * is the point — a design that dropped one between V(1) and V(2) is the normal
   * case, and the findings raised against it stay legitimate. Only a name that
   * appears in no version at all is drift. Skips when either artifact is absent.
   */
  private moduleTraceabilityErrors(): string[] {
    const arch = this.tableColumn2("technical/architecture.md", "M-\\d+");
    const matrix = this.tableColumn2("design/coverage-matrix.md", "(?!M-)[A-Za-z]{1,4}-\\d+");
    if (arch.size === 0 || matrix.size === 0) return [];
    const drift = [...matrix].filter((mod) => !arch.has(mod));
    if (drift.length === 0) return [];
    return [
      `[Phase 2] coverage_matrix cites module(s) absent from every version of the architecture table: ${drift.join(", ")}. ` +
      `Each module in a finding row must appear in specs/technical/architecture.md's module table (any \`## V(N)\` version). ` +
      `Either the name drifted — fix it to the Phase-1 module name — or the architecture is missing the module. ` +
      `Left unfixed, those findings point at modules no artifact records, and per-module traceability breaks after the session.`,
    ];
  }

  /** True when a passing run was witnessed in this phase (S4). */
  witnessedTestPass(phase: number): boolean {
    const t = this.state?.lastTestOutcome;
    // A pass reported from outside the project (a scratch copy, another checkout) is not
    // evidence about THIS project's suite.
    return !!t && t.outcome === "pass" && t.phase === phase && !t.outsideWorkspace;
  }

  /**
   * What is on record, so a refusal distinguishes "not observed" from "failed".
   * A gate that says only "no pass witnessed" reads the same whether the suite
   * went red or nobody ever ran it, and those call for opposite next moves.
   */
  private testOutcomeSummary(phase: number): string {
    const t = this.state?.lastTestOutcome;
    if (!t || t.phase !== phase) {
      return "Nothing has been recorded for this phase at all.";
    }
    const bits = [`outcome='${t.outcome}'`];
    if (t.command) bits.push(`command='${t.command}'`);
    bits.push(`at ${t.at}`);
    if (t.provenance?.exitCode !== undefined) bits.push(`exit=${t.provenance.exitCode}`);
    if (t.provenance?.source) bits.push(`via ${t.provenance.source}`);
    if (t.outcome === "pass" && t.outsideWorkspace) {
      return (
        `On record for this phase: a pass, but it ran OUTSIDE the project (in ${t.runDir ?? "?"}; ${bits.join(", ")}). ` +
        `A suite run from another directory is not evidence about this project's tests. Run it from inside the project.`
      );
    }
    const what =
      t.outcome === "unknown"
        ? "the last run could not be classified, which is not a pass"
        : "the last run failed";
    return `On record for this phase: ${what} (${bits.join(", ")}).`;
  }

  /**
   * Evidence a phase owes beyond its booleans, as messages rather than a flag:
   * a gate that blocks without naming what is missing is a dead end, which is
   * exactly the failure the safeguardViolations fix addressed.
   */
  private missingEvidence(phase: number): string[] {
    const out: string[] = [];
    // Declared mechanical checks: a criterion that declared one needs a reported result,
    // after the declaration, that meets the expectation.
    for (const ec of this.state?.exitCriteria ?? []) {
      if (ec.phase !== phase || !ec.check) continue;
      const w = ec.check.witnessed;
      const exitHint = ec.check.expect.startsWith("exit:") ? `; echo "VERSUS_EXIT=$?"` : "";
      if (!w || w.at < ec.check.declaredAt) {
        out.push(
          `[Phase ${phase}] ${ec.criterion}: declares the check \`${ec.check.command}\` (expect ${ec.check.expect}) but no ` +
          `result has been reported since. Run it in the terminal, exactly: \`${ec.check.command}${exitHint}\`, then report ` +
          `it with record_check_outcome(criterion='${ec.criterion}', output='<what it printed>'` +
          `${exitHint ? ", exit_code=<the VERSUS_EXIT number>" : ""}). A declared check is executed, not attested.`
        );
      } else if (!w.ok) {
        out.push(
          `[Phase ${phase}] ${ec.criterion}: the declared check \`${ec.check.command}\` was reported at ${w.at} and did NOT give ` +
          `${ec.check.expect}${typeof w.exitCode === "number" ? ` (exit ${w.exitCode})` : ""}. Output tail: ` +
          `${JSON.stringify(w.outputTail.slice(-200))}. Fix the cause, run it again and report it.`
        );
      }
    }
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
          `required structured form (needs at least ${def.artifactRows.count} table row(s) with ` +
          `an id, e.g. '${def.artifactRows.example}'). A prose or id-less file cannot be ` +
          `machine-read — each row needs its own id. The id needs a hyphen and the row needs its ` +
          `pipes: 'M01' and a line without '|' do not count.`
        );
      }
      if (def.verify === "lenses-recorded") {
        out.push(...this.lensRecordEvidence());
      }
      if (def.criterion === "lessons_documented" && this.artifactPresent("references/lessons.md")) {
        const unguarded = this.lessons().filter((l) => !l.guard);
        if (unguarded.length) {
          out.push(
            `[Phase ${phase}] lessons_documented: ${unguarded.length} lesson(s) in specs/references/lessons.md do not say whether ` +
            `they became a guard: ${unguarded.map((l) => `"${l.title.slice(0, 60)}"`).join(", ")}. Add a line ` +
            `\`guard: <test id>\` (the test that now catches it) or \`guard: none\` to each. A lesson kept only as text did ` +
            `not stop a recurrence before; the test did.`
          );
        }
      }
      if (def.verify === "test-pass" && !this.witnessedTestPass(phase)) {
        out.push(
          `[Phase ${phase}] ${def.criterion}: no passing test run was witnessed in this phase. ` +
          `${this.testOutcomeSummary(phase)} Run the suite with the exit status appended — ` +
          `\`<your command>; echo "VERSUS_TEST_EXIT=$?"\` — and report that number as ` +
          `record_test_outcome(command, exit_code=<n>). $? comes from the shell, so it decides the ` +
          `verdict whatever language the runner prints in, and 0 is the only pass. This host has no ` +
          `hook watching your shell, so an unreported run is an unwitnessed one. S4: never assume ` +
          `tests passed, execute and verify. Marking the criterion met is not enough.`
        );
      }
    }
    if (phase === 2) {
      out.push(...this.matrixRoundEvidence());
    }
    return out;
  }

  /** Text of the artifact, or "" when it is not there. */
  private readArtifact(relPath: string): string {
    try {
      const full = path.join(this.specsPath, relPath);
      return fs.existsSync(full) ? fs.readFileSync(full, "utf-8") : "";
    } catch {
      return "";
    }
  }

  /**
   * The lens set must be recorded once per round of the 2↔3 loop, as state rather
   * than prose. An accumulated declaration cannot say which set was in force when
   * a given finding was raised, so "this finding used a lens nobody activated"
   * stops being checkable — the union of every round always contains it.
   *
   * Prose is accepted only for a project created before this existed, which is
   * what `stateVersion` marks by its absence. Accepting it in a new project would
   * turn the structural guarantee into an opt-out.
   */
  private lensRecordEvidence(): string[] {
    if (!this.state) return [];
    const round = this.critiqueRound();
    if (this.lensActivation(round)) return [];

    if (this.state.stateVersion === undefined) {
      const prose = this.state.decisions.some((d) => {
        if (d.phase !== 2 || d.category !== "architecture") return false;
        if (!LENS_MARKER.test(d.content)) return false;
        const m = ITERATION_MARK.exec(d.content);
        return (m ? Number(m[1] ?? m[2]) : NaN) === round && VERSION_MARK.test(d.content);
      });
      if (prose) return [];
    }

    return [
      `[Phase 2] activated_lenses_recorded: no lens set recorded for iteration ${round}. Call ` +
      `record_activated_lenses(conditional=[...], notActivated=[{lens, reason}, ...]) — all 12 ` +
      `conditional lenses must be accounted for, each either activated or refused with its own ` +
      `reason. Each round of the 2↔3 loop critiques a different architecture, so each round records ` +
      `its own set; the previous round's does not carry over. Canonical names only: the tool refuses ` +
      `a translation or an abbreviation at the call, which is cheaper than discovering it in the ` +
      `matrix later.`,
    ];
  }

  /**
   * The `lens` and `severity` columns of every finding.
   *
   * Minimum form: the value is one of the 19 canonical names, or the literal
   * NENHUMA for a finding that fit no lens. `Sustainability` is refused —
   * truncation is what cost a project slot upstream, because the row gate only
   * ever read the first cell.
   *
   * Strong form: a conditional lens must have been declared for the round THAT
   * FINDING belongs to. Universals always pass. The round matters: a lens can
   * enter the set at round 2, which makes it legitimate there and anachronistic in
   * round 1. Where the round cannot be resolved — no heading, or no declaration
   * for that number — this degrades to the union of every declared set, which is
   * permissive by design: it must never block a legitimate project.
   */
  private lensColumnErrors(): string[] {
    const matrix = this.readArtifact("design/coverage-matrix.md");
    if (!matrix) return [];
    const findings = parseMatrixFindings(matrix);
    if (findings.length === 0) return [];

    const out: string[] = [];
    const unknown: string[] = [];
    // Resolved alongside each row, not keyed by id: ids are meant to be unique,
    // but a gate must not turn a duplicate id into the wrong verdict on a row.
    const resolved: Array<{ finding: MatrixFinding; canonical: string }> = [];

    // Severity is read the same way and for the same reason: the analysis counts
    // criticals against important on this column, so a value it cannot count is a
    // wrong count rather than a missing one. Tolerant of decoration, strict about
    // the signal — `🔴 Critical` passes, `high`, `P1`, an empty cell and `🔴🟡` do not.
    for (const f of findings) {
      const glyphs = SEVERITIES.filter((g) => f.severity.includes(g));
      if (glyphs.length !== 1) {
        out.push(
          `[Phase 2] coverage_matrix row ${f.id}: severity "${f.severity || "(empty)"}" must be ` +
          `exactly one of 🔴 (Critical) / 🟡 (Important) / 🟢 (Suggestion). Phase 6 traces every 🔴 to ` +
          `a test (critical-coverage.md), so this column must be machine-readable — a word, a code like ` +
          `"P1", or an empty cell cannot be read.`
        );
      }
    }

    for (const f of findings) {
      if (f.lens.trim().toUpperCase() === NO_LENS) continue;
      const c = canonicalLens(f.lens);
      if (!c) {
        unknown.push(`${f.id} → '${f.lens}'`);
      } else {
        resolved.push({ finding: f, canonical: c });
      }
    }

    if (unknown.length > 0) {
      out.push(
        `[Phase 2] coverage_matrix: the lens column is not a canonical lens name in ${unknown.length} ` +
        `finding(s): ${unknown.join("; ")}. Write the name exactly as the guidance spells it — ` +
        `'Sustainability / Proportionality', not 'Sustainability'; 'Security', not 'Segurança' or ` +
        `'SEG'. Case and the spacing around a slash are the only tolerated variation. The gate matches ` +
        `each finding's lens against the lenses declared for its round, and a truncated or translated ` +
        `name cannot be matched. A finding that fits no lens takes the literal ${NO_LENS}.`
      );
    }

    const declared = this.state?.activatedLenses ?? [];
    if (declared.length === 0) return out;
    const union = new Set(declared.flatMap((a) => a.conditional));

    for (const { finding: f, canonical: c } of resolved) {
      if (!isConditionalLens(c)) continue;
      const forRound = f.iteration === null ? undefined : this.lensActivation(f.iteration);
      const allowed = forRound ? new Set(forRound.conditional) : union;
      if (allowed.has(c)) continue;
      const where = forRound
        ? `iteration ${f.iteration}, which activated ${[...allowed].join(", ") || "no conditional lens"}`
        : `any round on record, which activated ${[...allowed].join(", ") || "no conditional lens"}`;
      out.push(
        `[Phase 2] coverage_matrix: finding ${f.id} uses the conditional lens '${c}', which was not ` +
        `declared for ${where}. Either the round applied a lens it never activated — record it with ` +
        `record_activated_lenses before critiquing — or the finding belongs to a different round and ` +
        `sits under the wrong '## Iteração N' heading.`
      );
    }

    return out;
  }

  /**
   * Past round 1 the matrix must carry a heading for the round in progress.
   * Without it every finding in the file collapses into iteration 1 and nothing
   * reports it — a silent wrong answer, not an error. In round 1 that default is
   * already correct, so an absent heading costs nothing and is not asked for.
   *
   * This does NOT check that the modules a finding names exist in the
   * architecture table; whether a name is traceable stays with the downstream
   * analysis, which validates it against the version of the round that raised it.
   */
  private matrixRoundEvidence(): string[] {
    const matrixText = this.readArtifact("design/coverage-matrix.md");
    if (!matrixText) return [];

    const round = this.state?.currentIteration ?? 1;
    if (round <= 1) return [];

    const iterations = parseMatrixIterations(matrixText);
    if (iterations.length === 0) return [];
    if (iterations.some((it) => it.iteration === round)) return [];

    return [
      `[Phase 2] coverage_matrix: specs/design/coverage-matrix.md has no section for iteration ` +
      `${round}. Append '## Iteração ${round} — V(${round})' above this round's rows, keeping ` +
      `the previous rounds below it — the token 'Iteração ${round}' is literal. Without the ` +
      `heading every finding in the file reads as iteration 1, and no one is told.`,
    ];
  }

  /**
   * Records how each `verify:` criterion of `phase` was satisfied. It adds no
   * criterion — it annotates the two that exist, so a degraded path stays visible
   * afterwards instead of reading identically to the strong one.
   */
  private stampVerificationProvenance(phase: number): void {
    if (!this.state) return;
    const at = new Date().toISOString();

    for (const def of getExitCriteriaForPhase(phase)) {
      if (!def.verify) continue;
      const entry = this.state.exitCriteria.find(
        (c) => c.phase === phase && c.criterion === def.criterion
      );
      if (!entry) continue;

      if (def.verify === "test-pass") {
        const t = this.state.lastTestOutcome;
        // Nominal means an exit code was observed and was 0. This build has no
        // hook watching the shell, so a pass is the model's word — allowed, and
        // worth being able to tell apart later.
        // Nominal means an exit status decided this and it was 0 — from the
        // harness, or relayed from the command's own echo. A verdict read off the
        // output instead is the degraded path, because reading depends on the
        // output's language and format and the exit status does not.
        const nominal = t?.provenance?.exitCode === 0;
        entry.verifiedBy = {
          path: nominal ? `test-pass/exit-${t!.provenance!.exitSource ?? "unknown"}` : "test-pass",
          nominal,
          at,
          note: nominal
            ? undefined
            : "pass classified without an exit status — no VERSUS_TEST_EXIT was reported",
          snapshot: t ? `${t.outcome} — ${t.command ?? "(no command)"} @ ${t.at}` : undefined,
        };
      }

      if (def.verify === "lenses-recorded") {
        const round = this.critiqueRound();
        const structured = this.lensActivation(round);
        entry.verifiedBy = {
          path: structured ? "lenses-recorded" : "lenses-recorded/prose-fallback",
          nominal: !!structured,
          at,
          note: structured ? undefined : "accepted through the legacy prose declaration",
          snapshot: structured
            ? `iteration ${structured.iteration} vs V(${structured.againstVersion}): ` +
              `${structured.conditional.join(", ") || "no conditional lens"}`
            : undefined,
        };
      }
    }
  }

  /**
   * III.1 — every 🔴 the critique raised must be answered in
   * specs/validation/critical-coverage.md, by a test or by a stated reason. A
   * critical that reached Phase 6 unmentioned is one nobody decided about; the
   * gate skips entirely when the matrix has no 🔴, since there is then nothing
   * to answer for.
   */
  private criticalCoverageErrors(): string[] {
    const matrix = this.readArtifact("design/coverage-matrix.md");
    if (!matrix) return [];
    const criticals = parseMatrixFindings(matrix).filter((f) => f.severity.includes("🔴"));
    if (criticals.length === 0) return [];

    const coverage = this.readArtifact("validation/critical-coverage.md");
    if (!coverage) {
      return [
        `[Phase 6] specs/validation/critical-coverage.md is missing, and the coverage matrix has ` +
        `${criticals.length} critical finding(s): ${criticals.map((f) => f.id).join(", ")}. Write ` +
        `one entry per 🔴 saying which test covers it, or why it needs none. A critical that ` +
        `reaches Phase 6 unmentioned is one nobody decided about.`,
      ];
    }

    const unanswered = criticals.filter((f) => !new RegExp(`\\b${escapeRegExp(f.id)}\\b`).test(coverage));
    if (unanswered.length === 0) return [];
    return [
      `[Phase 6] specs/validation/critical-coverage.md does not mention ${unanswered.length} ` +
      `critical finding(s): ${unanswered.map((f) => f.id).join(", ")}. Each 🔴 needs its own entry — ` +
      `the test that covers it, or the reason it needs none. Reference them by the matrix id so the ` +
      `link survives the session.`,
    ];
  }

  /**
   * III.2 — conditional by design. If the architecture NUMBERS its premises
   * (`A-1`, `P-A8`), each id must be answered in
   * specs/validation/premise-coverage.md. Where premises are prose — about half
   * the corpus — there is no id to check and the gate stays silent rather than
   * demanding a numbering convention that was never agreed.
   */
  private premiseCoverageErrors(): string[] {
    const arch = this.readArtifact("technical/architecture.md");
    if (!arch) return [];
    const ids = [...new Set((arch.match(/\b((?:P-A|A)-?\d+)\b/g) || []))];
    if (ids.length === 0) return [];

    const coverage = this.readArtifact("validation/premise-coverage.md");
    if (!coverage) {
      return [
        `[Phase 6] the architecture numbers ${ids.length} premise(s) (${ids.join(", ")}), but ` +
        `specs/validation/premise-coverage.md does not exist. Write one entry per numbered premise ` +
        `saying how Phase 6 checked it, or why it cannot be checked. A numbered premise is a claim ` +
        `the design leaned on; leaving it unexamined is the assumption failing silently.`,
      ];
    }

    const unanswered = ids.filter((id) => !new RegExp(`\\b${escapeRegExp(id)}\\b`).test(coverage));
    if (unanswered.length === 0) return [];
    return [
      `[Phase 6] specs/validation/premise-coverage.md does not mention ${unanswered.length} numbered ` +
      `premise(s): ${unanswered.join(", ")}. Reference each by the id the architecture gave it.`,
    ];
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
  recordTestOutcome(
    command: string,
    outcome: "pass" | "fail" | "unknown",
    provenance?: TestProvenance,
    runDir?: string
  ): { count: number; outsideWorkspace?: boolean; runDir?: string } {
    if (!this.state) return { count: 0 };

    // Witness for the tests_passing gate. Stamped before the branch, since the
    // pass path returns early through resetLoopCounter.
    this.state.lastTestOutcome = {
      outcome,
      phase: this.state.currentPhase,
      at: new Date().toISOString(),
      command: command || undefined,
      provenance,
    };

    // Where it ran (0.15.0). Only what the model reports: the run_dir it gives, followed
    // through any `cd`/`pushd` in the command it reports. Without either, nothing is
    // recorded and nothing changes — the gate cannot see what nobody said.
    const loc = this.locateRun(command, runDir);
    if (loc) {
      this.state.lastTestOutcome.runDir = loc.runDir;
      if (loc.outsideWorkspace) this.state.lastTestOutcome.outsideWorkspace = true;
    }

    // An inconclusive run is recorded and then does nothing else: it must not
    // satisfy the gate, and it must not feed S6 either. Counting it as a failure
    // would punish an unreadable output; ignoring it would leave a stale `fail`
    // frozen in place as the last thing anyone knew.
    if (outcome === "unknown") {
      this.save();
      return { count: this.state.loopCounter?.count ?? 0, ...loc };
    }

    if (outcome === "pass") {
      this.resetLoopCounter();
      return { count: 0, ...loc };
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
    return { count: this.state.loopCounter.count, ...loc };
  }

  /** The directory a reported run happened in, and whether that is outside the project. */
  private locateRun(command: string, runDir?: string): { runDir: string; outsideWorkspace: boolean } | undefined {
    const ws = path.resolve(this.workspacePath);
    const inside = (d: string) => {
      const rel = path.relative(ws, path.resolve(d));
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };
    const base = runDir?.trim() ? path.resolve(ws, runDir.trim()) : ws;
    const hasCd = parseShell(command).some((seg) => seg.words[0] === "cd" || seg.words[0] === "pushd");
    if (!runDir?.trim() && !hasCd) return undefined;
    const loc = testRunLocation(command, base, ws, loadExtraTestPatterns(this.workspacePath));
    if (loc) return { runDir: loc.runDir, outsideWorkspace: loc.outsideWorkspace };
    return runDir?.trim() ? { runDir: base, outsideWorkspace: !inside(base) } : undefined;
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
    // 0.15.0: only the RUNNER's own simple command counts, read structurally. A regex over
    // the whole command folded `; echo "VERSUS_TEST_EXIT=$?"` and `| grep …` into the
    // "target", so varying the plumbing (adding a pipe, switching to PIPESTATUS) restarted
    // the count and S6 under-counted. Flags, `--`, `cd` and pipes drop out; the suite stays.
    const patterns = [...TEST_COMMAND_PATTERNS, ...loadExtraTestPatterns(this.workspacePath)];
    for (const seg of parseShell(cmd)) {
      if (!patterns.some((p) => p.test(seg.words.join(" ")))) continue;
      const kept = seg.words.filter((w) => w !== "--" && !/^--?[\w-]+(=.*)?$/.test(w)).map((w) => w.toLowerCase());
      return kept.join(" ").slice(0, 80);
    }
    return cmd.trim().toLowerCase().substring(0, 50);
  }

  // --- Meta-iteration (v1.0 → v2.0) ---

  startNewCycle(): Result<{ cycle: number; archived: number; exportPath?: string }, string> {
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

    const approval = this.approvalMissing(7);
    if (approval.length > 0) {
      return { ok: false, error: approval.join(" ") };
    }

    // Cycle numbering: closed cycles are the 7→0 boundaries in history. Before 0.15.0
    // this counted arrivals at Phase 7 and added 2, so closing cycle 1 announced cycle 3.
    const cycle = this.currentCycle();
    const startedAt = this.cycleStartedAt();
    const closedAt = new Date().toISOString();

    const close: PhaseTransition = {
      from: 7,
      to: 0,
      timestamp: closedAt,
      criteriaMet: p7Criteria.map((c) => c.criterion),
    };
    const fp = this.designFingerprint();
    if (fp.length) close.artifacts = fp;
    close.decisionsAt = this.state.decisions.length;

    // Archive the cycle BEFORE the reset. The reset below used to be the end of this
    // cycle's exit criteria — details, provenance and all — so the record lost its own
    // history the moment the next cycle began.
    const record: CycleRecord = {
      cycle,
      startedAt,
      closedAt,
      phase0Score: this.state.phase0Score,
      exitCriteria: JSON.parse(JSON.stringify(this.state.exitCriteria)),
      transitions: [...this.state.history.filter((h) => h.timestamp > startedAt), close],
      lastTestOutcome: this.state.lastTestOutcome ? { ...this.state.lastTestOutcome } : undefined,
      decisionCount: this.state.decisions.filter((d) => d.timestamp >= startedAt && d.timestamp <= closedAt).length,
    };
    try {
      record.exportPath = this.writeCycleExport(this.renderCycleMarkdown(record), cycle);
    } catch { /* the archive in state.json is the record; the export is a convenience */ }
    if (!this.state.cycles) this.state.cycles = [];
    this.state.cycles.push(record);

    this.state.history.push(close);

    // Preserve: decisions, projectSpec, history, cycles
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
    return { ok: true, value: { cycle: cycle + 1, archived: cycle, exportPath: record.exportPath } };
  }

  // --- Promised tests, deviations, scope inventory, lessons ---

  /** Text of the architecture's latest version section (after the last `## V(N)`), or the whole file. */
  private latestArchitectureSection(): string {
    const text = this.readArtifact("technical/architecture.md");
    if (!text) return "";
    const idx = [...text.matchAll(/^##\s*V\(\d+\)/gm)].map((m) => m.index ?? 0);
    return idx.length ? text.slice(idx[idx.length - 1]) : text;
  }

  /** Test-promise ids (T-01…) the CURRENT design version names. */
  promisedTestIds(): string[] {
    return [...new Set([...this.latestArchitectureSection().matchAll(/\bT-\d+\b/g)].map((m) => m[0]))];
  }

  /** Concatenated text of the project's test files (bounded walk; build/vendor dirs skipped). */
  private testFilesText(): string {
    const SKIP = new Set(["node_modules", ".git", ".versus", "specs", "dist", "build", "out", ".next", "coverage",
      "DerivedData", "Pods", "vendor", ".venv", "venv", "target", ".gradle", ".idea", ".vscode"]);
    const TESTY = /(^|\/)(tests?|__tests__|spec|e2e|[\w-]*Tests?)(\/|$)|\.(test|spec)\.[\w]+$|_test\.[\w]+$|Tests?\.(swift|kt|java|cs)$/i;
    const chunks: string[] = [];
    let files = 0;
    const walk = (dir: string, rel: string) => {
      if (files > 5000) return;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith(".") && e.name !== ".github" && e.isDirectory()) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full, r); continue; }
        if (!e.isFile() || !TESTY.test(r)) continue;
        try {
          if (fs.statSync(full).size > 1_000_000) continue;
          chunks.push(fs.readFileSync(full, "utf-8"));
          files++;
        } catch { /* skip */ }
      }
    };
    walk(this.workspacePath, "");
    return chunks.join("\n");
  }

  /** 6→7: every test the current design promises (T-xx) must exist in a test file. */
  private testPromiseErrors(): string[] {
    const ids = this.promisedTestIds();
    if (!ids.length) return [];
    const text = this.testFilesText();
    const missing = ids.filter((id) => !new RegExp(`\\b${escapeRegExp(id)}\\b`).test(text));
    if (!missing.length) return [];
    return [
      `[Phase 6] promised tests: the current architecture version promises ${missing.join(", ")}, but no test file names ` +
      `${missing.length === 1 ? "it" : "them"}. Put the id in the test that implements the promise (its name or a comment), ` +
      `or, if the promise was dropped, say so in the architecture's Desvios section and remove the id. A promise that ` +
      `exists only in the design is not a test.`,
    ];
  }

  /** 6→7: the current design version records how the code deviated from it, or says "nenhum". */
  private deviationsErrors(): string[] {
    const sec = this.latestArchitectureSection();
    if (!sec) return [];   // architecture.md absence is reported by its own gate
    const lines = sec.split(/\r?\n/);
    const h = lines.findIndex((l) => /^#{2,4}\s*(Desvios|Deviations)\b/i.test(l));
    const body: string[] = [];
    if (h >= 0) {
      for (let i = h + 1; i < lines.length && !/^#{1,4}\s/.test(lines[i]); i++) if (lines[i].trim()) body.push(lines[i]);
    }
    if (h >= 0 && body.length) return [];
    return [
      `[Phase 6] deviations: the current version of specs/technical/architecture.md has no ${h >= 0 ? "content under its" : ""} ` +
      `"## Desvios" section. Before leaving Phase 6, record every way the code departed from this design, one line each with ` +
      `the reason (a timing that changed, a mechanism replaced, a state removed), or write "nenhum". Design drift left out of ` +
      `the record makes the architecture lie to the next cycle.`,
    ];
  }

  /** 5→6: a Scope Inventory decision of the current pass of Phase 5. */
  private scopeInventoryMissing(): string[] {
    const ok = this.decisionsSincePhaseEntry().some(
      (d) => d.phase === 5 && d.category.trim().toLowerCase() === "scope-inventory" && /[✅❌]/.test(d.content)
    );
    return ok ? [] : [
      `[Phase 5] scope inventory: no Scope Inventory on record for this pass of Phase 5. Run it (P1 modules present? ` +
      `specs/validation covered? UI runnable?) and record it: record_decision(phase=5, category='scope-inventory', ` +
      `content='<each item with ✅/❌>'). Displaying it in chat is not a record.`,
    ];
  }

  /** Lessons in specs/references/lessons.md: `##` sections (minus backlog/next-cycle) or top-level bullets. */
  lessons(): { title: string; guard: string | null }[] {
    const text = this.readArtifact("references/lessons.md");
    if (!text) return [];
    let lines = text.split(/\r?\n/);
    // A file that accumulates cycles ("# Ciclo 5 — …", "# Lessons — X (Cycle 2)") is scoped to
    // the CURRENT cycle's section, or to the last cycle section if none carries its number.
    // Lessons written in earlier cycles, before the rule existed, are not asked for a guard.
    const cycleHeads = lines
      .map((l, i) => { const m = /^#\s.*\b(?:ciclo|cycle)\s*(\d+)/i.exec(l); return m ? { i, n: parseInt(m[1], 10) } : null; })
      .filter((x): x is { i: number; n: number } => x !== null);
    if (cycleHeads.length) {
      const cur = this.currentCycle();
      const idx = cycleHeads.findIndex((c) => c.n === cur);
      const k = idx >= 0 ? idx : cycleHeads.length - 1;
      const start = cycleHeads[k].i;
      const nextH1 = lines.findIndex((l, i) => i > start && /^#\s/.test(l));
      lines = lines.slice(start + 1, nextH1 === -1 ? lines.length : nextH1);
    }
    // Word-initial: "dependências" is a lesson title, "Pendências" is not a lesson. Reference,
    // metric, debt and process-cost sections hold no project lessons either.
    const NOT_LESSON = /\bbacklog|\bpr[óo]ximo ciclo|\bnext cycle|\bv2(\.0)?\b|\bcarry|(^|[\s—–-])pend[eê]ncias?\b|\brefer[eê]ncias|\breferences\b|\bm[ée]tricas|\bmetrics\b|\bd[íi]vidas|\bdebts?\b|\bprocess cost|\bcusto do processo/i;
    const blocks: { title: string; body: string[] }[] = [];
    const ITEM = /^(?:[-*]|\d+[.)])\s+\S/;
    // Top-level list items of a run of lines, each with its indented continuation (and an
    // unindented `guard:` line right under it).
    const items = (ls: string[]): { title: string; body: string[] }[] => {
      const out: { title: string; body: string[] }[] = [];
      let cur: { title: string; body: string[] } | null = null;
      for (const l of ls) {
        if (ITEM.test(l)) { cur = { title: l.replace(/^(?:[-*]|\d+[.)])\s+/, "").trim(), body: [l] }; out.push(cur); }
        else if (cur && (/^\s+\S/.test(l) || /^guard:/i.test(l))) cur.body.push(l);
        else if (!l.trim()) continue;
        else cur = null;
      }
      return out;
    };
    const heads = lines.map((l, i) => (/^##\s+\S/.test(l) && !/^###/.test(l) ? i : -1)).filter((i) => i >= 0);
    if (heads.length) {
      heads.forEach((h, k) => {
        const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
        const title = lines[h].replace(/^##\s+/, "").trim();
        if (NOT_LESSON.test(title)) return;
        const section = lines.slice(h + 1, end);
        // "## 1. …" / "## Lição 3 — …" is ONE lesson (its bullets are details). A category heading
        // ("## Domain", "## Stack") groups lessons: each top-level item is one.
        const numbered = /^(?:\d+[.)]|li[cç][ãa]o\s*\d+|lesson\s*\d+|L\d+\b)/i.test(title);
        const its = numbered ? [] : items(section);
        if (its.length) blocks.push(...its);
        else blocks.push({ title, body: lines.slice(h, end) });
      });
    } else {
      blocks.push(...items(lines));
    }
    return blocks.map((b) => {
      const m = /\bguard:\s*([^\s,;)]+)/i.exec(b.body.join("\n"));
      return { title: b.title, guard: m ? m[1] : null };
    });
  }

  // --- Cycles, approvals, fingerprints, version ---

  /** The cycle in progress: closed cycles (7→0 boundaries) + 1. */
  currentCycle(): number {
    return (this.state?.history ?? []).filter((h) => h.from === 7 && h.to === 0).length + 1;
  }

  /** When the cycle in progress began: the last 7→0 boundary, or project creation. */
  cycleStartedAt(): string {
    const closes = (this.state?.history ?? []).filter((h) => h.from === 7 && h.to === 0);
    return closes.length ? closes[closes.length - 1].timestamp : (this.state?.createdAt ?? "");
  }

  /** Decisions recorded since the current phase was (last) entered. Ordered by the entry
   *  transition's decisionsAt when present, by timestamp for older history. */
  private decisionsSincePhaseEntry(): Decision[] {
    const st = this.state!;
    const h = st.history;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].to === st.currentPhase) {
        if (typeof h[i].decisionsAt === "number") return st.decisions.slice(h[i].decisionsAt);
        return st.decisions.filter((d) => d.timestamp >= h[i].timestamp);
      }
    }
    return st.decisions;
  }

  /** Message(s) when the current phase has no approval decision (approvedBy) since it was entered. */
  private approvalMissing(phase: number): string[] {
    if (!this.state) return [];
    const ok = this.decisionsSincePhaseEntry().some(
      (d) => d.phase === phase && !!d.approvedBy?.trim() && !!d.content?.trim()
    );
    if (ok) return [];
    const what =
      phase === 3 ? "the convergence decision (why this design version is ready to be verified)"
      : phase === 4 ? "the convergence confirmation (the Phase 4 verification report was PRESENTED and the user accepted it — before any code)"
      : phase === 6 ? "the test sign-off (what the user ran and saw, on which device/versions, and their verdict)"
      : "the cycle close (what the user reviewed and accepted)";
    return [
      `[Phase ${phase}] approval: no decision recording who approved ${what} in this phase. ` +
      `Call record_decision(phase=${phase}, category='approval', content='<what was presented and what the approver saw/said>', ` +
      `proposedBy='<who proposed>', approvedBy='<who approved, e.g. the user by name or role>'). ` +
      `A stamped criterion or a note in lessons.md is not a record of the approval.`,
    ];
  }

  /** sha256 + size of the design artifacts at this instant (empty when absent). */
  private designFingerprint(): { path: string; sha256: string; bytes: number }[] {
    const out: { path: string; sha256: string; bytes: number }[] = [];
    for (const rel of ["technical/architecture.md"]) {
      try {
        const full = path.join(this.specsPath, rel);
        if (!fs.existsSync(full)) continue;
        const buf = fs.readFileSync(full);
        out.push({ path: `specs/${rel}`, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length });
      } catch { /* ignore */ }
    }
    return out;
  }

  /** The cycle in progress, shaped like an archived record (closedAt empty). */
  private liveCycleRecord(): CycleRecord {
    const startedAt = this.cycleStartedAt();
    return {
      cycle: this.currentCycle(),
      startedAt,
      closedAt: "",
      phase0Score: this.state!.phase0Score,
      exitCriteria: this.state!.exitCriteria,
      transitions: this.state!.history.filter((h) => h.timestamp > startedAt),
      lastTestOutcome: this.state!.lastTestOutcome,
      decisionCount: this.state!.decisions.filter((d) => d.timestamp >= startedAt).length,
    };
  }

  /** Readable Markdown of one cycle: transitions, exit criteria with provenance, decisions. */
  renderCycleMarkdown(rec: CycleRecord): string {
    const st = this.state!;
    const name = (p: number) => getPhaseDefinition(p)?.name ?? `Phase ${p}`;
    const end = rec.closedAt || "\uffff";
    const decisions = st.decisions.filter((d) => d.timestamp >= rec.startedAt && d.timestamp <= end);
    const L: string[] = [];
    L.push(`# ${st.projectName} — Cycle ${rec.cycle}`);
    L.push("");
    L.push(
      `Exported by Versus LocalQwen ${VERSUS_VERSION} · started ${rec.startedAt || "?"} · ` +
      (rec.closedAt ? `closed ${rec.closedAt}` : `in progress (Phase ${st.currentPhase} — ${name(st.currentPhase)})`) +
      (rec.phase0Score !== null ? ` · Phase 0 score ${rec.phase0Score}/100` : "")
    );
    const closedBefore = rec.cycle - 1 - (st.cycles?.filter((c) => c.cycle < rec.cycle).length ?? 0);
    if (closedBefore > 0) {
      L.push("");
      L.push(`> ${closedBefore} earlier cycle(s) closed before Versus LocalQwen 0.15.0 archived cycles: their exit criteria were not kept; their transitions remain in state.json history.`);
    }
    L.push("");
    L.push("## Transitions");
    L.push("");
    if (!rec.transitions.length) L.push("_None yet._");
    else {
      L.push("| from → to | at | criteria met | design fingerprint |");
      L.push("|---|---|---|---|");
      for (const t of rec.transitions) {
        const fp = (t.artifacts ?? []).map((a) => `${a.path} ${a.sha256.slice(0, 12)} (${a.bytes} B)`).join("; ") || "—";
        L.push(`| ${t.from} → ${t.to} | ${t.timestamp} | ${t.criteriaMet.join(", ") || "—"} | ${fp} |`);
      }
    }
    L.push("");
    L.push("## Exit criteria");
    for (let p = 0; p <= 7; p++) {
      const cs = rec.exitCriteria.filter((c) => c.phase === p);
      if (!cs.length) continue;
      L.push("");
      L.push(`### Phase ${p} — ${name(p)}`);
      L.push("");
      for (const c of cs) {
        L.push(`- [${c.met ? "x" : " "}] **${c.criterion}**${c.details ? ` — ${c.details}` : ""}`);
        if (c.verifiedBy) {
          const v = c.verifiedBy;
          L.push(`  - verified by engine: ${v.path}, ${v.nominal ? "nominal" : "DEGRADED path"}, ${v.at}${v.note ? ` — ${v.note}` : ""}`);
        }
        if (c.check) {
          const w = c.check.witnessed;
          L.push(`  - declared check: \`${c.check.command}\` expect ${c.check.expect}` +
            (w ? ` — reported ${w.ok ? "OK" : "NOT OK"} at ${w.at} (by the model)` : " — no result reported"));
        }
      }
    }
    L.push("");
    L.push(`## Decisions (${decisions.length})`);
    for (let p = 0; p <= 7; p++) {
      const ds = decisions.filter((d) => d.phase === p);
      if (!ds.length) continue;
      L.push("");
      L.push(`### Phase ${p} — ${name(p)}`);
      for (const d of ds) {
        const who = [d.proposedBy ? `proposed by ${d.proposedBy}` : "", d.approvedBy ? `approved by ${d.approvedBy}` : ""]
          .filter(Boolean).join(" · ");
        L.push("");
        L.push(`- **[${d.category}]** ${d.timestamp}${who ? ` · ${who}` : ""}`);
        L.push("");
        for (const line of d.content.split("\n")) L.push(`  ${line}`);
      }
    }
    const t = rec.lastTestOutcome;
    if (t) {
      L.push("");
      L.push("## Last reported test run");
      L.push("");
      L.push(`- outcome: **${t.outcome}** (Phase ${t.phase}, ${t.at})`);
      if (t.command) L.push(`- command: \`${t.command.replace(/\n/g, " ⏎ ").slice(0, 400)}\``);
      if (typeof t.provenance?.exitCode === "number") L.push(`- exit status: ${t.provenance.exitCode} (from ${t.provenance.exitSource ?? "?"})`);
      if (t.runDir) L.push(`- ran in: ${t.runDir}${t.outsideWorkspace ? " — OUTSIDE the project" : ""}`);
      L.push(`- reported by the model through record_test_outcome (this host has no hook watching the shell)`);
    }
    L.push("");
    return L.join("\n");
  }

  /** Writes a cycle export to .versus/cycles/cycle-N.md; returns the workspace-relative path. */
  private writeCycleExport(md: string, cycle: number, suffix = ""): string {
    const rel = path.join(".versus", "cycles", `cycle-${cycle}${suffix}.md`);
    const full = path.join(this.workspacePath, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, md, "utf-8");
    return rel.replace(/\\/g, "/");
  }

  /** export_cycle: an archived cycle by number, or the cycle in progress (default). `final`
   *  writes the in-progress cycle under its closed name (the Phase 7 approval). */
  exportCycle(cycle?: number, final = false): Result<{ path: string; bytes: number; cycle: number; inProgress: boolean }, string> {
    if (!this.state) return { ok: false, error: "Project not initialized." };
    const cur = this.currentCycle();
    const target = cycle ?? cur;
    let rec: CycleRecord | undefined;
    if (target === cur) rec = this.liveCycleRecord();
    else rec = this.state.cycles?.find((c) => c.cycle === target);
    if (!rec) {
      return {
        ok: false,
        error: target > cur || target < 1
          ? `No cycle ${target}: the project is in cycle ${cur}.`
          : `Cycle ${target} closed before Versus LocalQwen 0.15.0 archived cycles — its exit criteria were not kept. ` +
            `Archived: ${(this.state.cycles ?? []).map((c) => c.cycle).join(", ") || "none"}.`,
      };
    }
    const md = this.renderCycleMarkdown(rec);
    const inProgress = target === cur && !final;
    const p = this.writeCycleExport(md, target, inProgress ? "-in-progress" : "");
    return { ok: true, value: { path: p, bytes: Buffer.byteLength(md, "utf-8"), cycle: target, inProgress } };
  }

  /**
   * One-time update notice. When the project was last opened by another Versus version,
   * returns what the running version requires from here on that the project lacks — and
   * records the migration. Does NOT create content: an empty lessons.md would pass an
   * existence gate while saying nothing, which is worse than the gate firing.
   */
  noteVersion(): { from: string | null; to: string; pending: string[] } | null {
    if (!this.state) return null;
    const from = this.state.versusVersion ?? null;
    if (from === VERSUS_VERSION) return null;
    const pending: string[] = [];
    const cur = this.state.currentPhase;
    for (let p = cur; p <= 7; p++) {
      for (const def of getExitCriteriaForPhase(p)) {
        if (def.required && def.artifact && !this.artifactPresent(def.artifact)) {
          pending.push(`specs/${def.artifact} — required by ${def.criterion} (Phase ${p}); missing or empty`);
        }
      }
    }
    if (cur <= 6 && this.criticalCoverageErrors().length > 0 && !this.artifactPresent("validation/critical-coverage.md")) {
      pending.push("specs/validation/critical-coverage.md — required at 6→7 (the matrix has 🔴 findings)");
    }
    if (from === null) {   // versusVersion is stamped from 0.15.0 on: null = an older Versus
      pending.push(
        "approval decisions — 3→4, 4→5, 6→7 and the cycle close now require record_decision(..., category='approval', approvedBy='<who>') in that phase"
      );
      if (cur <= 5) pending.push("5→6 now needs record_decision(phase=5, category='scope-inventory', content='<items with ✅/❌>')");
      if (cur <= 6) pending.push("6→7 now needs a '## Desvios' section in the current architecture version, and every promised test id (T-xx) present in a test file");
      const unguarded = this.lessons().filter((l) => !l.guard).length;
      if (unguarded) pending.push(`specs/references/lessons.md — ${unguarded} lesson(s) without 'guard: <test id>' or 'guard: none' (required to close the cycle)`);
    }
    this.state.versusVersion = VERSUS_VERSION;
    if (!this.state.migrations) this.state.migrations = [];
    this.state.migrations.push({ from, to: VERSUS_VERSION, at: new Date().toISOString(), pending });
    this.save();
    return { from, to: VERSUS_VERSION, pending };
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
