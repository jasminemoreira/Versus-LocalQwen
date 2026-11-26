// MCP Tools: state queries

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { StateEngine } from "../../state/engine";
import { SpecItem, specItemValue } from "../../state/types";
import { validateSafeguard } from "../../rules/safeguards";
import { getPhaseDefinition } from "../../rules/phases";
import { VERSUS_VERSION } from "../../version";

export const getPhaseStateTool: Tool = {
  name: "get_phase_state",
  description:
    "MUST be called at the start of every interaction. Returns current phase, iteration, score, " +
    "decisions, and safeguards of the Iterative Convergence methodology. " +
    "Without calling this tool, you don't know what phase you're in or what to do.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

export const getDecisionsTool: Tool = {
  name: "get_decisions",
  description:
    "Queries decisions made in any phase of the methodology. " +
    "Use to retrieve previous decisions before making new ones.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phase: {
        type: "number",
        description: "Phase number (0-7). If omitted, returns all decisions.",
      },
    },
    required: [],
  },
};

export const getExitCriteriaTool: Tool = {
  name: "get_exit_criteria",
  description:
    "Returns the exit criteria for a phase with status (met/pending). " +
    "Use to know what's missing before attempting to advance phases.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phase: {
        type: "number",
        description: "Phase number (0-7).",
      },
    },
    required: ["phase"],
  },
};

/**
 * How much of the state snapshot may go out at once, in characters.
 *
 * Same ceiling the guidance parts respect, and for the same reason: this host
 * writes a tool result larger than roughly 5.7 KB to a session-resource file
 * instead of putting it in front of the model. Measured in the wild — a project
 * with 72 decisions produced a 49 KB snapshot, six times over, and every call was
 * externalized. get_phase_state is the gateway guard, the one call the model is
 * told to make before anything else, so losing it loses the project's state.
 */
export const STATE_PAYLOAD_CHARS = 4096;

/** Split evenly: the decisions say what was chosen, the spec says under what constraints. */
const DECISIONS_BUDGET = STATE_PAYLOAD_CHARS / 2;
const SPEC_BUDGET = STATE_PAYLOAD_CHARS / 2;

/**
 * The newest entries of a projectSpec list that fit `budget`, in order.
 *
 * Entries are short and each is a distinct commitment — a median of 27 to 50
 * characters across the real projects — so nothing is truncated: knowing a
 * constraint exists matters more than its last words, and half a constraint
 * reads as a different constraint. Whole entries are dropped from the oldest end
 * instead, and counted, because a spec that quietly lost a third of itself is
 * worse than a short one that says so.
 */
export function fitSpecList(items: string[], budget: number): { kept: string[]; omitted: number } {
  const kept: string[] = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const cost = items[i].length + 3;
    if (used + cost > budget && kept.length > 0) break;
    kept.unshift(items[i]);
    used += cost;
  }
  return { kept, omitted: items.length - kept.length };
}

/** A decision as the snapshot carries it. */
interface BriefDecision {
  phase: number;
  category: string;
  content: string;
}

/**
 * The most recent decisions that fit the budget, newest last.
 *
 * Decisions are trimmed two ways before any is dropped: each one's content is
 * capped, then whole entries are shed from the oldest end. Both are reported —
 * a snapshot that quietly lost half the record would be worse than a short one,
 * because nothing downstream could tell the difference.
 */
export function fitDecisions(
  decisions: BriefDecision[],
  budget: number
): { kept: BriefDecision[]; omitted: number; shortened: number } {
  const CONTENT_CAP = 280;
  let shortened = 0;
  const capped = decisions.map((d) => {
    if (d.content.length <= CONTENT_CAP) return d;
    shortened += 1;
    return { ...d, content: `${d.content.slice(0, CONTENT_CAP)}… [truncated]` };
  });

  const kept: BriefDecision[] = [];
  let used = 0;
  for (let i = capped.length - 1; i >= 0; i--) {
    const cost = JSON.stringify(capped[i]).length + 1;
    if (used + cost > budget && kept.length > 0) break;
    kept.unshift(capped[i]);
    used += cost;
  }

  return { kept, omitted: decisions.length - kept.length, shortened };
}

export function handleGetPhaseState(engine: StateEngine): string {
  const state = engine.getPhaseState();
  if (!state) {
    return JSON.stringify({
      error: "Project not initialized. Call init_project first.",
    });
  }
  // Mark that model loaded context (gateway guard)
  engine.touchPhaseStateCheck();

  // Include projectSpec and recent decisions so any model has full context —
  // as much of it as this host will actually deliver inline.
  const brief = state.decisions.slice(-10).map((d) => ({
    phase: d.phase,
    category: d.category,
    content: d.content,
  }));
  const fitted = fitDecisions(brief, DECISIONS_BUDGET);
  const recentDecisions = fitted.kept;

  // Values only. Entries written between 0.7.0 and 0.14.x carry a {value, phase, at}
  // stamp (research instrumentation, no longer written since 0.15.0); the snapshot
  // never sends it.
  const spec = state.projectSpec ?? { stack: [], outOfScope: [], patterns: [], constraints: [] };
  const lists = {
    stack: spec.stack.map(specItemValue),
    outOfScope: spec.outOfScope.map(specItemValue),
    patterns: spec.patterns.map(specItemValue),
    constraints: spec.constraints.map(specItemValue),
  };
  const total = Object.values(lists).reduce((n, l) => n + l.length, 0) || 1;
  let specOmitted = 0;
  const projectSpec: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(lists)) {
    // Each list gets a share of the budget proportional to its size, so a long
    // list cannot starve a short one out of the snapshot entirely.
    const share = Math.max(200, Math.floor((SPEC_BUDGET * list.length) / total));
    const fit = fitSpecList(list, share);
    projectSpec[key] = fit.kept;
    specOmitted += fit.omitted;
  }

  // Detect Phase 7 completion → hint to offer new cycle
  let phase7Hint: string | undefined;
  if (state.currentPhase === 7) {
    const p7Criteria = state.exitCriteria.filter((c) => c.phase === 7);
    const allMet = p7Criteria.length > 0 && p7Criteria.every((c) => c.met);
    if (allMet) {
      phase7Hint =
        "ACTION REQUIRED: Phase 7 exit criteria are ALL met. You MUST offer the user a new development cycle " +
        "directly in chat (R2 format): Option 1 'Start next cycle' (calls start_new_cycle()) / " +
        "Option 2 'Project complete'. Do NOT skip this step.";
    }
  }

  // Detect "ready to advance" state for any phase < 7 — all criteria met but phase not advanced
  let readyToAdvanceHint: string | undefined;
  if (state.currentPhase < 7) {
    const phaseCriteria = engine.getExitCriteriaWithDefs(state.currentPhase);
    const allMet = phaseCriteria.length > 0 && phaseCriteria.every((c) => c.met);
    if (allMet) {
      readyToAdvanceHint = `⚠️ READY TO ADVANCE — Phase ${state.currentPhase} exit criteria are ALL met but currentPhase is still ${state.currentPhase}. Your VERY NEXT tool call MUST be advance_phase(target_phase=${state.currentPhase + 1}) followed by get_phase_guidance(). Do NOT write summary text. Do NOT wait for user input. Continue work into Phase ${state.currentPhase + 1} in the same turn.`;
    }
  }

  // One-time update notice: the first get_phase_state after this project was last opened
  // by another Versus version. This is the call the model makes first, so it is where the
  // notice reaches it; the engine records the migration and does not repeat it.
  const upd = engine.noteVersion();
  const cycle = engine.currentCycle();

  const response: Record<string, unknown> = {
    // The running build's version, so "which Versus served this session" is in the transcript
    // as a fact rather than an inference from file dates.
    header: `[Versus] Phase ${state.currentPhase} — ${getPhaseDefinition(state.currentPhase)?.name ?? "Unknown"} | Iteration ${state.currentIteration} | Cycle ${cycle} | v${VERSUS_VERSION}`,
    projectName: state.projectName,
    projectDescription: state.projectDescription,
    projectSpec,
    currentPhase: state.currentPhase,
    currentIteration: state.currentIteration,
    currentCycle: cycle,
    archivedCycles: (state.cycles ?? []).map((c) => c.cycle),
    phase0Score: state.phase0Score,
    decisionsCount: state.decisions.length,
    recentDecisions,
    // Live, for the same reason the sidebar is: the stored status is only written
    // by check_all_safeguards, so a model reading it would be told "ok" about a
    // safeguard that is currently vetoing its next transition.
    safeguards: state.safeguards.map((s) => ({ id: s.id, status: validateSafeguard(s.id, state).status })),
    // What the tests_passing gate will read. Without it the model had to open
    // state.json by hand to find out why the gate refused.
    lastTestOutcome: state.lastTestOutcome
      ? {
          ...state.lastTestOutcome,
          command:
            state.lastTestOutcome.command && state.lastTestOutcome.command.length > 160
              ? `${state.lastTestOutcome.command.slice(0, 160)}… [truncated]`
              : state.lastTestOutcome.command,
        }
      : null,
    updatedAt: state.updatedAt,
  };

  if (specOmitted > 0) {
    response._specNote =
      `${specOmitted} projectSpec entr${specOmitted === 1 ? "y is" : "ies are"} not shown — this ` +
      `host drops an oversized tool result to a file instead of showing it, so the snapshot is kept ` +
      `small. The complete spec is in .versus/state.json if you need an older entry.`;
  }

  if (fitted.omitted > 0 || fitted.shortened > 0) {
    response._decisionsNote =
      `Showing ${fitted.kept.length} of the last ${brief.length} decisions` +
      `${fitted.shortened > 0 ? `, ${fitted.shortened} of them shortened` : ""}` +
      `. This host drops an oversized tool result to a file instead of showing it, so the snapshot ` +
      `is kept small on purpose. Call get_decisions(phase) for the full text of any of them — ` +
      `${state.decisions.length} are on record.`;
  }

  if (upd) {
    response._versusUpdated =
      `VERSUS UPDATED — this project was last opened by ${upd.from ? `Versus LocalQwen ${upd.from}` : "a Versus LocalQwen older than 0.15.0"}; ` +
      `now ${upd.to}. TELL THE USER, once, in your next reply.` +
      (upd.pending.length
        ? ` Required from here on and missing in this project: ${upd.pending.slice(0, 6).map((p) => `(${p})`).join(" ")}` +
          (upd.pending.length > 6 ? ` … +${upd.pending.length - 6} more (see .versus/state.json migrations).` : "")
        : " Nothing the new version requires is missing.");
  }

  if (phase7Hint) {
    response._phase7Action = phase7Hint;
  }
  if (readyToAdvanceHint) {
    response._nextAction = readyToAdvanceHint;
  }

  return JSON.stringify(response);
}

export function handleGetDecisions(engine: StateEngine, args: { phase?: number }): string {
  const decisions = engine.getDecisions(args.phase);
  return JSON.stringify({ count: decisions.length, decisions });
}

export function handleGetExitCriteria(engine: StateEngine, args: { phase: number }): string {
  const criteria = engine.getExitCriteriaWithDefs(args.phase);
  const met = criteria.filter((c) => c.met).length;
  const total = criteria.length;
  return JSON.stringify({ phase: args.phase, met, total, criteria });
}

export const updateProjectSpecTool: Tool = {
  name: "update_project_spec",
  description:
    "Updates the project's structured technical context (stack, out-of-scope, patterns, constraints). " +
    "Use to record technical decisions in a structured way. " +
    "Items are added (merge), never overwritten. Duplicates are ignored.",
  inputSchema: {
    type: "object" as const,
    properties: {
      stack: {
        type: "array",
        items: { type: "string" },
        description: "Approved technologies for the project (e.g.: ['TypeScript', 'Node 18+', 'MCP SDK']).",
      },
      outOfScope: {
        type: "array",
        items: { type: "string" },
        description: "Items explicitly excluded from scope (e.g.: ['Local models', 'Web UI']).",
      },
      patterns: {
        type: "array",
        items: { type: "string" },
        description: "Architectural patterns to follow (e.g.: ['MCP server standalone', 'shared state.json']).",
      },
      constraints: {
        type: "array",
        items: { type: "string" },
        description: "Hard project constraints (e.g.: ['Copilot-only', 'No external dependencies']).",
      },
    },
    required: [],
  },
};

export function handleUpdateProjectSpec(
  engine: StateEngine,
  args: { stack?: string[]; outOfScope?: string[]; patterns?: string[]; constraints?: string[] }
): string {
  const values = (xs: SpecItem[]) => xs.map(specItemValue);
  const before = engine.getProjectSpec();
  const had = {
    stack: new Set(values(before.stack)),
    outOfScope: new Set(values(before.outOfScope)),
    patterns: new Set(values(before.patterns)),
    constraints: new Set(values(before.constraints)),
  };
  engine.updateProjectSpec(args);
  const after = engine.getProjectSpec();
  // Return what CHANGED plus counts, not the whole spec. The spec only grows, and on this
  // host a result past ~8K characters is moved to a file instead of reaching the model; the
  // whole-spec echo had reached 4,014 characters in a real session. The caller knows what it sent.
  const added: Record<string, string[]> = {};
  const counts: Record<string, number> = {};
  for (const k of ["stack", "outOfScope", "patterns", "constraints"] as const) {
    const n = values(after[k]).filter((v) => !had[k].has(v));
    if (n.length) added[k] = n;
    counts[k] = after[k].length;
  }
  return JSON.stringify({
    success: true,
    added,
    counts,
    message:
      "Project spec updated. Values already present were kept, not duplicated. get_phase_state shows the newest entries per list.",
  });
}
