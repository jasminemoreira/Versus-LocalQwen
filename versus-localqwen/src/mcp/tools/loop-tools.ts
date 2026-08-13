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
      exit_code: {
        type: "number",
        description:
          "The process exit status, if you have it. Get it language-independently by appending the " +
          "echo to your command: `npm test; echo \"VERSUS_TEST_EXIT=$?\"` — then report the number " +
          "printed. 0 is a pass, anything else a failure, in any language and any output format. " +
          "When given, this decides the outcome and `outcome` is not needed. Do NOT modify the test " +
          "runner to make its output easier to read: append the echo to the command instead.",
      },
      outcome: {
        type: "string",
        enum: ["pass", "fail", "unknown"],
        description:
          "'pass' if the run was green, 'fail' if it was red, 'unknown' if the output could not be " +
          "read as either — a crashed runner, a truncated log, a command that never produced a verdict. " +
          "'unknown' is recorded and blocks the gate without counting towards S6: reporting it is always " +
          "better than guessing. Report honestly — a false pass hides the loop from you, not from the tests.",
      },
      failed: {
        type: "boolean",
        description: "Deprecated, kept for older callers: true means 'fail', false means 'pass'. Prefer `outcome`.",
      },
    },
    required: ["command"],
  },
};

export function handleRecordTestOutcome(
  engine: StateEngine,
  args: { command: string; exit_code?: number; outcome?: "pass" | "fail" | "unknown"; failed?: boolean }
): string {
  const state = engine.getPhaseState();
  if (!state) {
    return JSON.stringify({ error: "Project not initialized. Call init_project first." });
  }

  // Exit status first: it is the only signal that does not depend on the output
  // being in a language or a format anything here recognises. Then `outcome`,
  // then the old `failed` boolean. With none of them the run is inconclusive by
  // definition — which is what `unknown` is for, and better than a default verdict.
  const exitCode = typeof args.exit_code === "number" ? args.exit_code : undefined;
  const outcome: "pass" | "fail" | "unknown" =
    exitCode !== undefined
      ? exitCode === 0
        ? "pass"
        : "fail"
      : args.outcome ?? (args.failed === undefined ? "unknown" : args.failed ? "fail" : "pass");

  const { count } = engine.recordTestOutcome(args.command ?? "", outcome, {
    source: "mcp-tool",
    exitCode,
    exitSource: exitCode !== undefined ? "echo" : undefined,
    note:
      exitCode !== undefined
        ? "exit status relayed from the command's own echo; this host has no hook to capture it directly"
        : "no exit status reported — the verdict is the model's reading of the output",
  });

  if (outcome === "unknown") {
    return JSON.stringify({
      recorded: "unknown",
      undiagnosedFailures: count,
      threshold: LOOP_FAILURE_THRESHOLD,
      note:
        "Recorded as inconclusive. It does not satisfy tests_passing and does not count towards S6. " +
        "Run the suite again with the exit status appended — `<your command>; echo \"VERSUS_TEST_EXIT=$?\"` " +
        "— and report that number as exit_code. $? comes from the shell, so it works whatever language " +
        "the runner prints in.",
    });
  }
  // Ask the safeguard, not the counter. isLoopBlocked() only knows the count,
  // so before Phase 5 it would claim a violation that check_safeguard denies —
  // and two answers to the same question is worse than either answer.
  const blocked = engine.checkSafeguard("S6").status === "violated";
  const remaining = Math.max(0, LOOP_FAILURE_THRESHOLD - count);

  if (outcome === "pass") {
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
