// VS Code prompts for the alignment command. Kept apart from align.ts so the
// modelfile patching stays importable — and testable — outside the extension host.

import * as vscode from "vscode";
import { Fit } from "./vram";

/**
 * Asks for the window size, defaulting to what fits this GPU.
 *
 * The default used to be whatever this developer's machine ran, which put a
 * smaller card on the edge: pinning a window it cannot hold pushes the KV cache
 * to system RAM, where generation drops 20-50x and the session reads as frozen
 * with no error anywhere. `fit` carries its own arithmetic so the number can be
 * checked rather than trusted, and is absent when it could not be computed.
 */
export async function promptForNumCtx(
  suggested: number | null,
  fit?: Fit | null
): Promise<number | undefined> {
  const value = await vscode.window.showInputBox({
    title: "Align model context window",
    prompt: fit
      ? `Tokens to pin as num_ctx. Suggested ${fit.numCtx}: ${fit.explanation}`
      : "Tokens to pin as num_ctx. Use the window your GPU actually sustains — measure with " +
        "'ollama ps' during inference and confirm PROCESSOR stays at 100% GPU.",
    value: String(fit?.numCtx ?? suggested ?? 65536),
    validateInput: (raw) => {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 2048) return "Enter an integer of at least 2048.";
      if (n > 1_048_576) return "That is larger than any current model supports.";
      return undefined;
    },
  });
  return value === undefined ? undefined : Number(value);
}
