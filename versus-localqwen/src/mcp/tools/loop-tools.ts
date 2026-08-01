// MCP Tool: S6 loop detection input.
//
// The sibling extensions feed this counter from CLI hooks — a PostToolUse hook
// reads the exit status of every shell command and records failures, and a
// PreToolUse hook blocks the next run. VS Code chat has neither, so the counter
// has to be fed from inside the conversation.
//
// That is a weaker guarantee and it should be named as one: a hook observes the
// run whether or not the model cooperates, while this tool depends on the model
// calling it. What it buys is the part that matters most — the count becomes
// visible in check_safeguard and in the sidebar, and a violated S6 vetoes the
// next phase transition through validatePhaseTransition, which is enforcement
// the model cannot route around.

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { StateEngine, LOOP_FAILURE_THRESHOLD } from "../../state/engine";

export const recordTestOutcomeTool: Tool = {
  name: "record_test_outcome",
  description:
    "Records whether a test or build run passed or failed. Call it after EVERY test run in " +
    "Phases 5 and 6, immediately, before deciding what to do next.\n\n" +
    "This drives S6, which exists to stop blind debugging — re-running tests hoping something " +
    "sticks, without a named cause. It does not restrict debugging: only failures accumulate, " +
    `a passing run clears the count, and ${LOOP_FAILURE_THRESHOLD} consecutive failures with no ` +
    "diagnosis recorded between them violate S6 and block the next phase transition.\n\n" +
    "The escape is to name the cause: record_decision(category='diagnosis') clears the counter " +
    "immediately. Fix a test, name why it broke, run again — the count never accumulates. If you " +
    "cannot name a cause in one sentence, you do not have one, and that is the moment S6 exists " +
    "to catch: go Tier 2 and find a reference implementation.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description:
          "The command that was run, e.g. 'pytest tests/test_tasks.py' or 'npm test -- consent'. " +
          "The suite or target matters: failures in different suites are counted separately.",
      },
      failed: {
        type: "boolean",
        description: "true if the run failed, false if it passed. Report honestly — a false pass hides the loop from you, not from the tests.",
      },
    },
    required: ["command", "failed"],
  },
};

export function handleRecordTestOutcome(
  engine: StateEngine,
  args: { command: string; failed: boolean }
): string {
  const state = engine.getPhaseState();
  if (!state) {
    return JSON.stringify({ error: "Project not initialized. Call init_project first." });
  }

  const { count } = engine.recordTestOutcome(args.command ?? "", args.failed);
  // Ask the safeguard, not the counter. isLoopBlocked() only knows the count,
  // so before Phase 5 it would claim a violation that check_safeguard denies —
  // and two answers to the same question is worse than either answer.
  const blocked = engine.checkSafeguard("S6").status === "violated";
  const remaining = Math.max(0, LOOP_FAILURE_THRESHOLD - count);

  if (!args.failed) {
    return JSON.stringify({
      recorded: "pass",
      undiagnosedFailures: 0,
      threshold: LOOP_FAILURE_THRESHOLD,
      note: "Counter cleared. A passing run is the end of the work, never a loop.",
    });
  }

  return JSON.stringify({
    recorded: "failure",
    undiagnosedFailures: count,
    threshold: LOOP_FAILURE_THRESHOLD,
    s6Violated: blocked,
    _nextAction: blocked
      ? "STOP. S6 is violated and the next phase transition is vetoed. Do NOT run the tests again. " +
        "Either name the root cause now via record_decision(category='diagnosis', content='<cause + " +
        "the fix it implies>'), or go Tier 2: consult specs/technical and specs/examples for a " +
        "reference implementation and record THAT as the diagnosis."
      : `Name the cause of this failure via record_decision(category='diagnosis') before re-running. ` +
        `${remaining} more undiagnosed ${remaining === 1 ? "failure" : "failures"} violates S6.`,
  });
}
