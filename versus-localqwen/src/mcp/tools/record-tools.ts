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
          "'diagnosis' (root cause of a test failure — clears the S6 loop counter; 'bugfix' and 'root-cause' are aliases), " +
          "'approval' (a human sign-off, with approvedBy), 'scope-inventory', 'undiscussed-choices'.",
      },
      content: {
        type: "string",
        description: "Decision content in free text.",
      },
      proposedBy: {
        type: "string",
        description: "Who proposed it, e.g. 'Qwen' or 'user'.",
      },
      approvedBy: {
        type: "string",
        description:
          "Who approved it, and on what basis ('user, after running it in the browser'). REQUIRED on the approval " +
          "decision that 3→4, 4→5, 6→7 and the cycle close are refused without.",
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
      check_command: {
        type: "string",
        description:
          "A command that checks the criterion mechanically (e.g. `grep -rli oauth services/ | wc -l`). The gate then " +
          "needs a result reported with record_check_outcome, after this, that meets check_expect.",
      },
      check_expect: {
        type: "string",
        description:
          "'exit:<n>' (default 'exit:0') or 'output:<regex>' matched against the output.",
      },
    },
    required: ["phase", "criterion", "met"],
  },
};

export const recordCheckOutcomeTool: Tool = {
  name: "record_check_outcome",
  description:
    "Reports what a check declared with mark_exit_criterion(check_command=...) printed. Run the command exactly " +
    "as declared (for 'exit:' append `; echo \"VERSUS_EXIT=$?\"`). The engine compares it with the expectation.",
  inputSchema: {
    type: "object" as const,
    properties: {
      criterion: { type: "string" },
      output: { type: "string", description: "What it printed (the last lines suffice)." },
      exit_code: { type: "number", description: "The VERSUS_EXIT number." },
      phase: { type: "number", description: "Defaults to the current phase." },
    },
    required: ["criterion", "output"],
  },
};

export function handleRecordCheckOutcome(
  engine: StateEngine,
  args: { criterion: string; output?: string; exit_code?: number; phase?: number }
): string {
  const r = engine.recordCheckOutcome(
    String(args.criterion ?? ""),
    typeof args.output === "string" ? args.output : "",
    typeof args.exit_code === "number" ? args.exit_code : undefined,
    typeof args.phase === "number" ? args.phase : undefined
  );
  if (!r.ok) return JSON.stringify({ success: false, error: r.error });
  return JSON.stringify({
    success: true,
    ...r.value,
    note: r.value.ok
      ? "The reported result meets the declared expectation; the gate will accept this check."
      : `The reported result does NOT meet ${r.value.expect}. The transition stays blocked on this criterion until a run that does is reported.`,
  });
}

export function handleRecordDecision(
  engine: StateEngine,
  args: { phase: number; category: string; content: string; proposedBy?: string; approvedBy?: string }
): string {
  try {
    const decision = engine.recordDecision(args.phase, args.category, args.content, {
      proposedBy: typeof args.proposedBy === "string" ? args.proposedBy : undefined,
      approvedBy: typeof args.approvedBy === "string" ? args.approvedBy : undefined,
    });
    const result: Record<string, unknown> = {
      success: true,
      id: decision.id,
      timestamp: decision.timestamp,
    };
    // The Phase 7 approval closes the cycle whether or not a new one follows. A project
    // that ENDS at Phase 7 never calls start_new_cycle, so its readable record was never
    // written. Write it here; start_new_cycle rewrites it from the archive if work goes on.
    const st = engine.getPhaseState();
    if (decision.approvedBy && args.phase === 7 && st?.currentPhase === 7) {
      const ex = engine.exportCycle(undefined, true);
      if (ex.ok) result._export = `Cycle ${ex.value.cycle} record written to ${ex.value.path} (${ex.value.bytes} bytes).`;
    }
    return JSON.stringify(result);
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
  args: { phase: number; criterion: string; met: boolean; details?: string; check_command?: string; check_expect?: string }
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
    let checkNote: string | undefined;
    if (typeof args.check_command === "string" && args.check_command.trim()) {
      const d = engine.declareCheck(args.phase, args.criterion, args.check_command, args.check_expect);
      if (!d.ok) return JSON.stringify({ success: false, error: d.error });
      const exp = args.check_expect?.trim() || "exit:0";
      checkNote =
        `Check declared. Now run it in the terminal, exactly: \`${args.check_command.trim()}` +
        `${exp.startsWith("exit:") ? `; echo "VERSUS_EXIT=$?"` : ""}\`, then report it with ` +
        `record_check_outcome(criterion='${args.criterion}', output='<what it printed>'` +
        `${exp.startsWith("exit:") ? ", exit_code=<the VERSUS_EXIT number>" : ""}). The gate needs a reported ${exp}.`;
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
    if (checkNote) response._check = checkNote;
    // Lessons that did not become a guard are listed for the HUMAN to decide on.
    if (args.criterion === "lessons_documented") {
      const ls = engine.lessons();
      const none = ls.filter((l) => l.guard?.toLowerCase() === "none").map((l) => l.title.slice(0, 80));
      const missing = ls.filter((l) => !l.guard).map((l) => l.title.slice(0, 80));
      if (none.length) response._lessonsWithoutGuard = { lessons: none, action: "Show these to the user: each is a lesson kept only as text. Ask whether any should become a test now." };
      if (missing.length) response._lessonsMissingGuardLine = { lessons: missing, action: "Add 'guard: <test id>' or 'guard: none' to each — start_new_cycle is blocked until every lesson says." };
    }

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
