// MCP Tools: detailed behavioral instructions per phase

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { StateEngine } from "../../state/engine";
import { getFullGuidance, splitGuidance } from "../../rules/full-guidance";

/**
 * The tool the model should put user decisions through, if any.
 *
 * Our own `ask_user` wherever the client negotiated elicitation — no
 * configuration, and the answer comes from the person rather than from the
 * model. `versus-localqwen.askUserTool` stays as an override for a host with a
 * tool of its own; empty on both means the questions stay chat blocks.
 */
export function resolveAskUserTool(elicitationAvailable: boolean): string | undefined {
  const override = (process.env.VERSUS_ASK_USER_TOOL || "").trim();
  if (override) return override;
  return elicitationAvailable ? "ask_user" : undefined;
}

export const getPhaseGuidanceTool: Tool = {
  name: "get_phase_guidance",
  description:
    "Returns the instructions for the current or specified phase: global rules, " +
    "mandatory questions, templates, protocols, checklists, and criteria. " +
    "Call when entering each new phase to know exactly what to do. " +
    "Delivered in PARTS, in order — the response says which part it is and how many " +
    "there are. Keep calling with the next `part` until you have them all; a phase " +
    "read halfway is a phase run without half its rules. " +
    "Complements get_phase_state which returns only the state.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phase: {
        type: "number",
        description: "Phase number (0-7). If omitted, uses the current phase.",
      },
      part: {
        type: "number",
        description:
          "Which part of the phase's instructions to return, from 1. Omit for the first. " +
          "Parts are in reading order and every one of them is needed.",
      },
    },
    required: [],
  },
};

export function handleGetPhaseGuidance(
  engine: StateEngine,
  args: { phase?: number; part?: number },
  askUserTool?: string
): string {
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
    return partResponse(0, null, args.part, askUserTool, { initialized: false });
  }

  const phase = args.phase ?? state.currentPhase;

  if (phase < 0 || phase > 7) {
    return JSON.stringify({ error: `Invalid phase: ${phase}. Use 0-7.` });
  }

  return partResponse(phase, state.currentPhase, args.part, askUserTool);
}

/**
 * One part of a phase's guidance, plus what to do next.
 *
 * The whole phase used to go out in a single result. On this host that result is
 * large enough to be written to a session-resource file instead of reaching the
 * model, which means the phase's rules arrived only if the model noticed the file
 * and went to read it. Parts stay under the inline limit, so they arrive.
 *
 * The trade is that a phase can now be read halfway, which the previous shape
 * made impossible. `_nextAction` is what closes that: it is the same mechanism
 * advance_phase uses to chain to the next call, and it stays on every part but
 * the last.
 */
function partResponse(
  phase: number,
  currentPhase: number | null,
  requested: number | undefined,
  askUserTool: string | undefined,
  extra: Record<string, unknown> = {}
): string {
  const parts = splitGuidance(getFullGuidance(phase, { askUserTool }));
  const part = requested === undefined ? 1 : Math.trunc(requested);

  if (part < 1 || part > parts.length) {
    return JSON.stringify({
      error:
        `Phase ${phase} guidance has ${parts.length} part(s); part ${part} does not exist. ` +
        `Ask for 1..${parts.length}.`,
      phase,
      totalParts: parts.length,
    });
  }

  const response: Record<string, unknown> = {
    phase,
    currentPhase,
    part,
    totalParts: parts.length,
    ...extra,
    guidance: parts[part - 1],
  };

  if (part < parts.length) {
    response._nextAction =
      `INCOMPLETE — this is part ${part} of ${parts.length}. Your VERY NEXT tool call MUST be ` +
      `get_phase_guidance(phase=${phase}, part=${part + 1}). Do not start the phase's work, and do ` +
      `not answer the user, until you have read every part: the rules are split across them, and ` +
      `acting on part ${part} alone means acting without the rest.`;
  }

  return JSON.stringify(response);
}
