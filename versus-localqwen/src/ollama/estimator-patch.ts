// Clamps the Ollama provider's chars-per-token ratio so it cannot collapse.
//
// The provider does not tokenize. It keeps a ratio per model, starting at 4,
// and recalibrates after every response as `text.length / prompt_eval_count`.
// The numerator comes from partToText, which returns '' for tool calls, tool
// results and non-text parts; the denominator counts the whole prompt. In an
// agent session most of the prompt is what the numerator drops, so each
// tool-heavy turn moves the ratio halfway toward a much smaller value and
// countTokens starts pricing text several times over.
//
// The clamp keeps upward calibration — a model that genuinely runs coarser than
// 4 chars/token is still learned — and blocks only the downward slide, which
// measures nothing real.
//
// No vscode import: the extension and scripts/patch-ollama-estimator.mjs both
// use this, so the logic has exactly one home.

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export const PATCH_MARKER = "/* versus-localqwen: floor clamped */";

const ORIGINAL =
  "        this.charsPerToken.set(modelID, (currentCharsPerToken + observedCharsPerToken) / 2);";

const PATCHED =
  "        this.charsPerToken.set(modelID, Math.max(defaultCharsPerToken, " +
  `(currentCharsPerToken + observedCharsPerToken) / 2)); ${PATCH_MARKER}`;

export type PatchState =
  /** The clamp is in place. */
  | "patched"
  /** The known calibration line is there, unpatched — safe to apply. */
  | "patchable"
  /**
   * Neither the marker nor the line we know how to patch. The provider was
   * rewritten, so applying anything here would be guesswork.
   */
  | "unknown-shape"
  /** No provider file at that path. */
  | "missing";

export function backupPathFor(providerPath: string): string {
  return `${providerPath}.versus-backup`;
}

export function inspect(providerPath: string): PatchState {
  if (!existsSync(providerPath)) return "missing";
  const source = readFileSync(providerPath, "utf-8");
  if (source.includes(PATCH_MARKER)) return "patched";
  return source.includes(ORIGINAL) ? "patchable" : "unknown-shape";
}

export interface PatchResult {
  state: PatchState;
  changed: boolean;
  providerPath: string;
  message: string;
}

export function applyPatch(providerPath: string): PatchResult {
  const state = inspect(providerPath);

  if (state !== "patchable") {
    return {
      state,
      changed: false,
      providerPath,
      message:
        state === "patched"
          ? "Already clamped."
          : state === "missing"
            ? "No provider.js at that path."
            : "The calibration line was not found — the provider changed shape. " +
              "Inspect CalibratedTokenEstimator.record() before patching by hand.",
    };
  }

  const source = readFileSync(providerPath, "utf-8");
  const backup = backupPathFor(providerPath);
  if (!existsSync(backup)) {
    copyFileSync(providerPath, backup);
  }
  writeFileSync(providerPath, source.replace(ORIGINAL, PATCHED), "utf-8");

  return {
    state: "patched",
    changed: true,
    providerPath,
    message: `Clamped. Original kept at ${backup}.`,
  };
}

export function revertPatch(providerPath: string): PatchResult {
  const backup = backupPathFor(providerPath);
  if (!existsSync(backup)) {
    return { state: inspect(providerPath), changed: false, providerPath, message: "No backup to restore." };
  }
  copyFileSync(backup, providerPath);
  return { state: inspect(providerPath), changed: true, providerPath, message: "Restored from backup." };
}

/**
 * Locates installed Ollama provider files by scanning the extension roots.
 *
 * The extension host knows the exact path through the extensions API and should
 * pass it directly; this exists for the standalone script, which has no such
 * API, and for the case where an update left more than one version on disk.
 */
export function findProviders(roots: string[]): string[] {
  const found: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (!/^ollama\.ollama-/i.test(entry)) continue;
      const provider = join(root, entry, "out", "provider.js");
      if (existsSync(provider)) found.push(provider);
    }
  }
  return found;
}
