// MCP Tools: decision, score, and exit criteria recording

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { StateEngine } from "../../state/engine";
import { ScoreBreakdown } from "../../state/types";

export const recordDecisionTool: Tool = {
  name: "record_decision",
  description:
    "Records a decision made during any phase. Decisions persist across sessions " +
    "and can be queried with get_decisions. Use to not lose architectural, " +
    "scope, pattern decisions, etc. " +
    "In P5-P6, category='diagnosis' also clears the S6 loop counter: it is how you " +
    "state the root cause of a failing test before re-running. Debugging with a named " +
    "cause per round is the normal cycle and is never blocked.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phase: {
        type: "number",
        description: "Phase in which the decision was made (0-7).",
      },
      category: {
        type: "string",
        description:
          "Category: 'architecture', 'pattern', 'constraint', 'scope', 'technology', 'requirement', 'testing', " +
          "'process' (methodology/session decisions, e.g. an LLM switch or session renewal), " +
          "'diagnosis' (root cause of a test failure — clears the S6 loop counter; 'bugfix' and 'root-cause' are aliases).",
      },
      content: {
        type: "string",
        description: "Decision content in free text.",
      },
    },
    required: ["phase", "category", "content"],
  },
};

export const updateScoreTool: Tool = {
  name: "update_score",
  description:
    "Updates the Phase 0 convergence score (0-100) with breakdown by criterion. " +
    "Score >= 90 is required to advance to Phase 1.",
  inputSchema: {
    type: "object" as const,
    properties: {
      score: {
        type: "number",
        description: "Total score (0-100).",
      },
      breakdown: {
        type: "object",
        description: "Breakdown by criterion.",
        properties: {
          clarezaProblema: { type: "number", description: "Weight 10" },
          casosDeUso: { type: "number", description: "Weight 15" },
          vocabulario: { type: "number", description: "Weight 10" },
          ambiguidades: { type: "number", description: "Weight 15" },
          foraDeEscopo: { type: "number", description: "Weight 10" },
          criteriosSucesso: { type: "number", description: "Weight 10" },
          premissas: { type: "number", description: "Weight 10" },
          documentacao: { type: "number", description: "Weight 5" },
          usuarioConfirmou: { type: "number", description: "Weight 10" },
          iaConfiante: { type: "number", description: "Weight 5" },
        },
      },
    },
    required: ["score", "breakdown"],
  },
};

export const markExitCriterionTool: Tool = {
  name: "mark_exit_criterion",
  description:
    "Marks an exit criterion as met or pending. Use get_exit_criteria to see " +
    "available criteria and their IDs.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phase: {
        type: "number",
        description: "Phase (0-7).",
      },
      criterion: {
        type: "string",
        description: "Criterion ID (e.g., 'score_90', 'user_confirmed', 'tech_feasibility').",
      },
      met: {
        type: "boolean",
        description: "true if met, false if pending.",
      },
      details: {
        type: "string",
        description: "Optional details about how it was met.",
      },
    },
    required: ["phase", "criterion", "met"],
  },
};

export function handleRecordDecision(
  engine: StateEngine,
  args: { phase: number; category: string; content: string }
): string {
  try {
    const decision = engine.recordDecision(args.phase, args.category, args.content);
    return JSON.stringify({
      success: true,
      id: decision.id,
      timestamp: decision.timestamp,
    });
  } catch (err) {
    return JSON.stringify({ success: false, error: String(err) });
  }
}

export function handleUpdateScore(
  engine: StateEngine,
  args: { score: number; breakdown: ScoreBreakdown }
): string {
  try {
    engine.updateScore(args.score, args.breakdown);
    return JSON.stringify({
      success: true,
      score: args.score,
      meetsThreshold: args.score >= 90,
    });
  } catch (err) {
    return JSON.stringify({ success: false, error: String(err) });
  }
}

export function handleMarkExitCriterion(
  engine: StateEngine,
  args: { phase: number; criterion: string; met: boolean; details?: string }
): string {
  try {
    // Only the CURRENT phase's criteria can be marked. advance_phase reads only those, so a
    // past phase's mark is inert — and a FUTURE phase's mark is pre-stamping: the ESJUD study's
    // G2/G3 gates landed in the same second because Phase 3 was done (and its criteria marked)
    // while Versus still said Phase 2. The engine method stays unrestricted (tests drive it).
    const current = engine.getPhaseState()?.currentPhase;
    if (typeof current === "number" && args.phase !== current) {
      return JSON.stringify({
        success: false,
        error:
          `Cannot mark a Phase ${args.phase} criterion: the current phase is ${current}. ` +
          (args.phase > current
            ? `Criteria are marked in the phase they belong to — finish Phase ${current}, advance_phase(target_phase=${current + 1}), then mark.`
            : `Phase ${args.phase} is already closed; only Phase ${current} criteria gate the next transition.`),
        currentPhase: current,
      });
    }
    engine.markExitCriterion(args.phase, args.criterion, args.met, args.details);
    const criteria = engine.getExitCriteriaWithDefs(args.phase);
    const metCount = criteria.filter((c) => c.met).length;
    const allMet = metCount === criteria.length && criteria.length > 0;

    const response: Record<string, unknown> = {
      success: true,
      phase: args.phase,
      criterion: args.criterion,
      met: args.met,
      totalMet: metCount,
      totalCriteria: criteria.length,
    };

    // When all criteria for any phase < 7 become met, force next action: advance_phase
    if (allMet && args.phase < 7 && args.met) {
      const state = engine.getPhaseState();
      if (state && state.currentPhase === args.phase) {
        response._nextAction = `⚠️ ALL Phase ${args.phase} exit criteria are now met. Your VERY NEXT tool call MUST be advance_phase(target_phase=${args.phase + 1}) — no summary text, no closing prose. After advance_phase(), call get_phase_guidance() to load Phase ${args.phase + 1} instructions and continue work in the same turn.`;
      }
    }

    // Detect Phase 7 full completion → hint to offer new cycle
    if (args.phase === 7 && allMet) {
      response._phase7Action =
        "ALL Phase 7 exit criteria are now met. You MUST offer the user a new development cycle " +
        "directly in chat (R2 format): Option 1 'Start next cycle' (calls start_new_cycle()) / " +
        "Option 2 'Project complete'. Do NOT skip this step.";
    }

    return JSON.stringify(response);
  } catch (err) {
    return JSON.stringify({ success: false, error: String(err) });
  }
}
