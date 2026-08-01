// MCP Tools: detailed behavioral instructions per phase

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { StateEngine } from "../../state/engine";
import { getFullGuidance } from "../../rules/full-guidance";

export const getPhaseGuidanceTool: Tool = {
  name: "get_phase_guidance",
  description:
    "Returns COMPLETE instructions for the current or specified phase: global rules, " +
    "mandatory questions, templates, protocols, checklists, and criteria. " +
    "Call when entering each new phase to know exactly what to do. " +
    "Complements get_phase_state which returns only the state.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phase: {
        type: "number",
        description: "Phase number (0-7). If omitted, uses the current phase.",
      },
    },
    required: [],
  },
};

export function handleGetPhaseGuidance(engine: StateEngine, args: { phase?: number }): string {
  const state = engine.getPhaseState();

  // Phase 0 guidance is served before initialization on purpose: it carries the
  // bootstrap protocol the model must follow to call init_project correctly.
  // Requiring an initialized project to read it would be circular.
  if (!state) {
    const phase = args.phase ?? 0;
    if (phase !== 0) {
      return JSON.stringify({
        error: "Project not initialized. Only phase 0 guidance is available before init_project.",
      });
    }
    return JSON.stringify({
      phase: 0,
      currentPhase: null,
      initialized: false,
      guidance: getFullGuidance(0),
    });
  }

  const phase = args.phase ?? state.currentPhase;

  if (phase < 0 || phase > 7) {
    return JSON.stringify({ error: `Invalid phase: ${phase}. Use 0-7.` });
  }

  const guidance = getFullGuidance(phase);

  return JSON.stringify({
    phase,
    currentPhase: state.currentPhase,
    guidance,
  });
}
