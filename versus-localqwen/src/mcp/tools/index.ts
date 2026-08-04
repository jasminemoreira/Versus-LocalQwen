// Central registry of all MCP tools

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { StateEngine } from "../../state/engine";

import { getPhaseStateTool, getDecisionsTool, getExitCriteriaTool, updateProjectSpecTool, handleGetPhaseState, handleGetDecisions, handleGetExitCriteria, handleUpdateProjectSpec } from "./state-tools";
import { advancePhaseTool, startIterationTool, startNewCycleTool, handleAdvancePhase, handleStartIteration, handleStartNewCycle } from "./transition-tools";
import { recordDecisionTool, updateScoreTool, markExitCriterionTool, handleRecordDecision, handleUpdateScore, handleMarkExitCriterion } from "./record-tools";
import { checkSafeguardTool, checkAllSafeguardsTool, handleCheckSafeguard, handleCheckAllSafeguards } from "./safeguard-tools";
import { checkSpecsStatusTool, handleCheckSpecsStatus } from "./specs-tools";
import { initProjectTool, handleInitProject } from "./project-tools";
import { getPhaseGuidanceTool, handleGetPhaseGuidance } from "./guidance-tools";
import { checkContextBudgetTool, handleCheckContextBudget } from "./context-tools";
import { recordTestOutcomeTool, handleRecordTestOutcome } from "./loop-tools";

export const ALL_TOOLS: Tool[] = [
  getPhaseStateTool,
  getDecisionsTool,
  getExitCriteriaTool,
  advancePhaseTool,
  startIterationTool,
  recordDecisionTool,
  updateScoreTool,
  markExitCriterionTool,
  checkSafeguardTool,
  checkAllSafeguardsTool,
  checkSpecsStatusTool,
  initProjectTool,
  getPhaseGuidanceTool,
  updateProjectSpecTool,
  startNewCycleTool,
  checkContextBudgetTool,
  recordTestOutcomeTool,
];

/**
 * What the tool definitions cost on every request, before any conversation
 * exists. A window that cannot hold this truncates every turn regardless of how
 * small the work is, which no payload-sized check would ever notice.
 * Schemas tokenize at ~4.4 chars/token on qwen3.6, so this errs slightly high.
 */
export function toolSurface(): { toolCount: number; tokens: number } {
  const chars = ALL_TOOLS.reduce(
    (sum, t) =>
      sum + JSON.stringify({ name: t.name, description: t.description, parameters: t.inputSchema }).length,
    0
  );
  return { toolCount: ALL_TOOLS.length, tokens: Math.ceil(chars / 4.4) };
}

// Tools exempt from gateway guard (they ARE the "context loading" themselves).
// check_context_budget joins them: it is what you call to find out whether
// there is room to load context at all, so demanding context first is circular.
const GUARD_EXEMPT = new Set([
  "get_phase_state",
  "init_project",
  "start_new_cycle",
  "check_context_budget",
]);

const CONTEXT_WARNING =
  "MANDATORY ACTION: Call get_phase_state() and get_phase_guidance() BEFORE proceeding. " +
  "Without loaded context, your actions may be inconsistent with decisions already made in the project.";

export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  engine: StateEngine
): Promise<string> {
  const result = await dispatch(toolName, args, engine);

  // Gateway guard: warns models that haven't loaded context
  if (!GUARD_EXEMPT.has(toolName) && engine.isContextStale()) {
    try {
      const parsed = JSON.parse(result);
      parsed._contextWarning = CONTEXT_WARNING;
      return JSON.stringify(parsed);
    } catch {
      return result;
    }
  }

  return result;
}

// --- Arg sanitizers: coerce types from LLMs that send strings instead of numbers/booleans ---

function toNumber(val: unknown): number | undefined {
  if (val === undefined || val === null) return undefined;
  const n = Number(val);
  return isNaN(n) ? undefined : n;
}

function toBoolean(val: unknown): boolean {
  if (typeof val === "boolean") return val;
  if (val === "true" || val === "1") return true;
  if (val === "false" || val === "0") return false;
  return Boolean(val);
}

function toStringArray(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string") return [val];
  return undefined;
}

function sanitize(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  if ("phase" in out) out.phase = toNumber(out.phase);
  if ("target_phase" in out) out.target_phase = toNumber(out.target_phase);
  if ("score" in out) out.score = toNumber(out.score);
  if ("met" in out) out.met = toBoolean(out.met);
  if ("stack" in out) out.stack = toStringArray(out.stack);
  if ("outOfScope" in out) out.outOfScope = toStringArray(out.outOfScope);
  if ("patterns" in out) out.patterns = toStringArray(out.patterns);
  if ("constraints" in out) out.constraints = toStringArray(out.constraints);
  if ("planned_chars" in out) out.planned_chars = toNumber(out.planned_chars);
  if ("failed" in out) out.failed = toBoolean(out.failed);
  return out;
}

async function dispatch(
  toolName: string,
  rawArgs: Record<string, unknown>,
  engine: StateEngine
): Promise<string> {
  const args = sanitize(rawArgs);
  switch (toolName) {
    case "check_context_budget":
      return handleCheckContextBudget(args as { planned_chars?: number; intent?: string }, toolSurface());
    case "record_test_outcome":
      return handleRecordTestOutcome(engine, args as { command: string; failed: boolean });
    case "get_phase_state":
      return handleGetPhaseState(engine);
    case "get_decisions":
      return handleGetDecisions(engine, args as { phase?: number });
    case "get_exit_criteria":
      return handleGetExitCriteria(engine, args as { phase: number });
    case "advance_phase":
      return handleAdvancePhase(engine, args as { target_phase: number });
    case "start_iteration":
      return handleStartIteration(engine, args as { phase: number });
    case "record_decision":
      return handleRecordDecision(engine, args as { phase: number; category: string; content: string });
    case "update_score":
      return handleUpdateScore(engine, args as { score: number; breakdown: any });
    case "mark_exit_criterion":
      return handleMarkExitCriterion(engine, args as { phase: number; criterion: string; met: boolean; details?: string });
    case "check_safeguard":
      return handleCheckSafeguard(engine, args as { id: string });
    case "check_all_safeguards":
      return handleCheckAllSafeguards(engine);
    case "check_specs_status":
      return handleCheckSpecsStatus(engine);
    case "init_project":
      return handleInitProject(engine, args as { name: string; description: string; bootstrap_data?: Record<string, unknown> });
    case "get_phase_guidance":
      return handleGetPhaseGuidance(engine, args as { phase?: number });
    case "update_project_spec":
      return handleUpdateProjectSpec(engine, args as { stack?: string[]; outOfScope?: string[]; patterns?: string[]; constraints?: string[] });
    case "start_new_cycle":
      return handleStartNewCycle(engine);
    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}
