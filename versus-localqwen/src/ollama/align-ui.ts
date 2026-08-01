// VS Code prompts for the alignment command. Kept apart from align.ts so the
// modelfile patching stays importable — and testable — outside the extension host.

import * as vscode from "vscode";

/** Asks for the window size, defaulting to what the server already loaded. */
export async function promptForNumCtx(suggested: number | null): Promise<number | undefined> {
  const value = await vscode.window.showInputBox({
    title: "Align model context window",
    prompt:
      "Tokens to pin as num_ctx. Use the window your GPU actually sustains — measure with " +
      "'ollama ps' during inference and confirm PROCESSOR stays at 100% GPU.",
    value: String(suggested ?? 65536),
    validateInput: (raw) => {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 2048) return "Enter an integer of at least 2048.";
      if (n > 1_048_576) return "That is larger than any current model supports.";
      return undefined;
    },
  });
  return value === undefined ? undefined : Number(value);
}
