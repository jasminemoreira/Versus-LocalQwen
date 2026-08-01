// The chat host's compaction threshold.
//
// Auto-compaction is a designed behaviour, not a fault: the host summarises the
// conversation before the window is actually full, keeping headroom for tool
// schemas and the next response. On a frontier model with a 200k window that
// headroom is invisible. On a 64k local model it is most of the session, and
// each compaction costs context the model then spends tokens re-reading.
//
// The threshold is configurable, which makes it the largest single lever
// available for a local model — larger than anything on the Ollama side.

import * as vscode from "vscode";

/**
 * Both ids the bundled Copilot extension binds this setting to. The public one
 * is contributed in its package.json; the `chat.advanced.*` form is the
 * internal alias it reads first.
 */
export const THRESHOLD_SETTINGS = [
  "github.copilot.chat.summarizeAgentConversationHistoryThreshold",
  "chat.advanced.summarizeAgentConversationHistoryThreshold",
] as const;

export type Threshold =
  /** Unset — the host uses its own default headroom over the full window. */
  | { kind: "unset" }
  /** A fraction of the model's context window, e.g. 0.9. */
  | { kind: "ratio"; value: number; setting: string }
  /** An absolute token count, e.g. 55000. */
  | { kind: "absolute"; value: number; setting: string };

/** Values below this are read as ratios by the host; at or above, as token counts. */
const ABSOLUTE_FLOOR = 100;

export function readThreshold(): Threshold {
  for (const setting of THRESHOLD_SETTINGS) {
    const lastDot = setting.lastIndexOf(".");
    const section = setting.slice(0, lastDot);
    const key = setting.slice(lastDot + 1);
    const value = vscode.workspace.getConfiguration(section).get<number | null>(key);
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    return value >= ABSOLUTE_FLOOR
      ? { kind: "absolute", value, setting }
      : { kind: "ratio", value, setting };
  }
  return { kind: "unset" };
}

/**
 * The token count the threshold pins compaction to, when it pins one at all.
 * Unset returns null: the host's own default headroom is not published, so
 * guessing at it here would be inventing a number.
 */
export function compactionPoint(threshold: Threshold, maxInputTokens: number): number | null {
  switch (threshold.kind) {
    case "ratio":
      return Math.floor(maxInputTokens * threshold.value);
    case "absolute":
      return threshold.value;
    case "unset":
      return null;
  }
}

export function describeThreshold(threshold: Threshold, maxInputTokens: number | undefined): string {
  switch (threshold.kind) {
    case "unset":
      return "unset — the host keeps its own headroom, and compacts before the window is full";
    case "ratio": {
      const point = maxInputTokens ? ` (~${Math.floor(maxInputTokens * threshold.value)} tokens)` : "";
      return `${threshold.value} of the window${point}`;
    }
    case "absolute":
      return `${threshold.value} tokens`;
  }
}

/**
 * Writes the threshold to user settings. Prefers the public setting id, which
 * is the one contributed in the Copilot extension's package.json and therefore
 * the one that survives a rename of the internal alias.
 */
export async function writeThreshold(value: number): Promise<string> {
  const setting = THRESHOLD_SETTINGS[0];
  const lastDot = setting.lastIndexOf(".");
  await vscode.workspace
    .getConfiguration(setting.slice(0, lastDot))
    .update(setting.slice(lastDot + 1), value, vscode.ConfigurationTarget.Global);
  return setting;
}

/**
 * Asks for a threshold. Offers an absolute count derived from the model's real
 * budget rather than a ratio, because a ratio silently re-scales if the window
 * changes and the point of setting this is to know where compaction lands.
 */
export async function promptForThreshold(maxInputTokens: number | undefined): Promise<number | undefined> {
  const suggested = maxInputTokens ? Math.floor(maxInputTokens * 0.9) : 0.9;
  const raw = await vscode.window.showInputBox({
    title: "Compaction threshold",
    prompt:
      "A ratio of the context window (0 to 1, e.g. 0.9) or an absolute token count (100 or more). " +
      "Higher means fewer compactions but less headroom — if a turn then overflows on a model " +
      "without KV cache shifting, it dies mid-emission instead of being summarised.",
    value: String(suggested),
    validateInput: (text) => {
      const n = Number(text);
      if (!Number.isFinite(n) || n <= 0) return "Enter a positive number.";
      if (n > 1 && n < ABSOLUTE_FLOOR) return "Use a ratio of at most 1, or a count of at least 100.";
      if (n >= ABSOLUTE_FLOOR && !Number.isInteger(n)) return "An absolute token count must be an integer.";
      if (maxInputTokens && n >= ABSOLUTE_FLOOR && n > maxInputTokens) {
        return `Above the model's ${maxInputTokens}-token input budget.`;
      }
      return undefined;
    },
  });
  return raw === undefined ? undefined : Number(raw);
}
