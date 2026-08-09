// Core types for Versus

export interface PhaseState {
  agent?: "copilot" | "claude" | "localqwen";  // identifies which extension owns this state
  /**
   * Format version of this file. Its ABSENCE is what marks a project written
   * before the structured lens declaration existed, which is the only case where
   * the old prose declaration is still accepted. Stamped by init_project so the
   * fallback cannot become an opt-out in a new project.
   */
  stateVersion?: number;
  projectName: string;
  projectDescription: string;
  projectSpec: ProjectSpec;      // structured technical context
  currentPhase: number;          // 0-7
  currentIteration: number;      // within the phase
  phase0Score: number | null;    // 0-100
  phase0Breakdown: ScoreBreakdown | null;
  decisions: Decision[];
  exitCriteria: ExitCriterionState[];
  safeguards: SafeguardState[];
  loopCounter: LoopCounter;
  /** One entry per critique round — an array, never an accumulated record. */
  activatedLenses?: LensActivation[];
  /** Last test run the engine witnessed, via record_test_outcome. Gates tests_passing. */
  lastTestOutcome?: { outcome: "pass" | "fail"; phase: number; at: string };
  lastPhaseStateCheck?: string;  // ISO timestamp — gateway guard for smaller models
  createdAt: string;             // ISO timestamp
  updatedAt: string;
  history: PhaseTransition[];    // transition log
}

/**
 * One projectSpec entry, stamped with when it was recorded. Without the stamp
 * the spec can only be read as it stands now, so "which entries existed when
 * Phase 2 declared its lenses?" has no answer — and an analysis that cannot date
 * the spec has to drop it whole rather than risk crediting the critique with
 * context it never saw.
 */
export interface SpecEntry {
  value: string;
  phase: number;
  at: string;                    // ISO timestamp
}

/** Read in both forms: bare strings from projects written before 0.7.0, and stamped entries. */
export type SpecItem = string | SpecEntry;

/**
 * The lens set a single round of Phase 2 critiqued with. One of these per round:
 * the set evolves between rounds, so a finding can only be checked against the
 * set that was in force when it was raised. An accumulated record would make
 * "this finding used a lens nobody activated" uncheckable, since the union of
 * every round always contains the lens.
 */
export interface LensActivation {
  universal: string[];                                  // the 7, always
  conditional: string[];                                // the subset activated THIS round
  notActivated: { lens: string; reason: string }[];
  iteration: number;                                    // 1 = first pass through Phase 2
  againstVersion: number;                               // the architecture V(N) it was decided against
  recordedAt: string;                                   // ISO
}

/** Structured technical context — survives model switches */
export interface ProjectSpec {
  stack: SpecItem[];             // approved technologies (e.g., "TypeScript", "Node 18+")
  outOfScope: SpecItem[];        // explicitly excluded (e.g., "Local models")
  patterns: SpecItem[];          // architectural patterns (e.g., "MCP server standalone")
  constraints: SpecItem[];       // rigid constraints (e.g., "local model only, no cloud fallback")
}

/** The text of an entry, whichever form it was stored in. */
export function specItemValue(item: SpecItem): string {
  return typeof item === "string" ? item : item.value;
}

/**
 * S6 loop detection. `count` is consecutive test FAILURES with no diagnosis
 * recorded between them — not test executions. A passing run, a recorded
 * diagnosis, or a phase change all clear it. Debugging with a named cause per
 * round is the normal cycle; failing repeatedly without naming a cause is the
 * blind loop S6 exists to stop.
 */
export interface LoopCounter {
  pattern: string;             // normalized command pattern of the failing runs
  count: number;               // consecutive undiagnosed failures
  firstSeen: string;           // ISO timestamp
  lastSeen: string;
  lastDiagnosis?: string;      // ISO timestamp of the diagnosis that last cleared the counter
}

export interface ScoreBreakdown {
  clarezaProblema: number;       // weight 10
  casosDeUso: number;            // weight 15
  vocabulario: number;           // weight 10
  ambiguidades: number;          // weight 15
  foraDeEscopo: number;          // weight 10
  criteriosSucesso: number;      // weight 10
  premissas: number;             // weight 10
  documentacao: number;          // weight 5
  usuarioConfirmou: number;      // weight 10
  iaConfiante: number;           // weight 5
}

export interface Decision {
  id: string;
  phase: number;
  category: string;
  content: string;
  timestamp: string;
}

export interface ExitCriterionState {
  phase: number;
  criterion: string;
  met: boolean;
  details?: string;
}

export interface SafeguardState {
  id: string;                  // "S0" to "S7"
  status: "ok" | "warning" | "violated";
  details?: string;
  lastChecked?: string;
}

export interface SpecsStatus {
  [directory: string]: {
    populated: boolean;
    fileCount: number;
  };
}

export interface PhaseTransition {
  from: number;
  to: number;
  timestamp: string;
  criteriaMet: string[];
}

export interface TransitionError {
  message: string;
  missingCriteria: string[];
  specsWarnings?: string[];
  safeguardViolations?: string[];  // a violated safeguard vetoes the transition — say which
}

export interface IterationInfo {
  phase: number;
  iterationNumber: number;
  previousSummary?: string;
}

export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/**
 * Current state format. Bumped only when a reader needs to tell the shapes apart;
 * its presence alone is what says "this project was created after the structured
 * lens declaration became mandatory".
 */
export const STATE_VERSION = 1;

export function createDefaultState(name: string, description: string): PhaseState {
  return {
    agent: "localqwen",
    stateVersion: STATE_VERSION,
    projectName: name,
    projectDescription: description,
    projectSpec: { stack: [], outOfScope: [], patterns: [], constraints: [] },
    currentPhase: 0,
    currentIteration: 1,
    phase0Score: null,
    phase0Breakdown: null,
    decisions: [],
    exitCriteria: [],
    safeguards: [
      { id: "S0", status: "ok" },
      { id: "S1", status: "ok" },
      { id: "S2", status: "ok" },
      { id: "S3", status: "ok" },
      { id: "S4", status: "ok" },
      { id: "S5", status: "ok" },
      { id: "S6", status: "ok" },
      { id: "S7", status: "ok" },
    ],
    loopCounter: { pattern: "", count: 0, firstSeen: "", lastSeen: "" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: [],
  };
}
