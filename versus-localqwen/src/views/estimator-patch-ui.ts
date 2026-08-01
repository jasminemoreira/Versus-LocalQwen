// Keeps the Ollama estimator clamp in place across provider updates.
//
// An Ollama update installs into a new versioned directory, so the clamp is
// silently gone and the only symptom is the usable-tokens figure sliding again
// mid-session. Checking on activation turns that into a one-time notification
// at the moment it happens.
//
// Ordering matters and cannot be worked around: by the time we activate, the
// Ollama extension has already loaded provider.js into memory. Patching the
// file now takes effect at the NEXT extension host start, never the current
// one. So the notification is not a courtesy — without the restart the session
// runs unclamped regardless of what is on disk.

import * as vscode from "vscode";
import {
  applyPatch,
  findProviders,
  inspect,
  PatchState,
} from "../ollama/estimator-patch";
import { resetEstimator } from "../ollama/reset-estimator";

const OLLAMA_EXTENSION_ID = "Ollama.ollama";

/** Exact path from the extensions API, with a directory scan as fallback. */
function locateProviders(): string[] {
  const ext = vscode.extensions.getExtension(OLLAMA_EXTENSION_ID);
  if (ext) {
    const direct = vscode.Uri.joinPath(ext.extensionUri, "out", "provider.js").fsPath;
    if (inspect(direct) !== "missing") return [direct];
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return [];
  return findProviders([
    vscode.Uri.joinPath(vscode.Uri.file(home), ".vscode-server", "extensions").fsPath,
    vscode.Uri.joinPath(vscode.Uri.file(home), ".vscode", "extensions").fsPath,
  ]);
}

function describeShapeChange(providerPath: string): void {
  vscode.window
    .showWarningMessage(
      "Versus: the Ollama provider's token estimator no longer matches the line this " +
        "extension knows how to clamp. It may have been fixed upstream, or rewritten. " +
        "The usable-tokens figure in the status bar will tell you which.",
      "Open provider.js"
    )
    .then((action) => {
      if (action === "Open provider.js") {
        vscode.window.showTextDocument(vscode.Uri.file(providerPath));
      }
    });
}

/**
 * Applies the clamp when it is missing and asks for the restart that loads it.
 *
 * Silent when there is nothing to do, which is the normal case — the point is
 * to cost nothing until an Ollama update removes the patch.
 */
export async function ensureEstimatorClamp(
  log: (msg: string) => void,
  opts: { auto: boolean; announceNoop?: boolean } = { auto: true }
): Promise<void> {
  const providers = locateProviders();
  if (providers.length === 0) {
    log("estimator clamp: no Ollama provider.js found");
    if (opts.announceNoop) {
      vscode.window.showInformationMessage("Versus: no installed Ollama provider to clamp.");
    }
    return;
  }

  const states = providers.map((p) => [p, inspect(p)] as [string, PatchState]);

  if (states.every(([, s]) => s === "patched")) {
    log(`estimator clamp: already in place (${providers.length} provider file(s))`);
    if (opts.announceNoop) {
      vscode.window.showInformationMessage("Versus: the Ollama token estimator is already clamped.");
    }
    return;
  }

  const shapeChanged = states.filter(([, s]) => s === "unknown-shape");
  if (shapeChanged.length > 0 && states.every(([, s]) => s !== "patchable")) {
    log(`estimator clamp: provider shape changed at ${shapeChanged[0][0]}`);
    describeShapeChange(shapeChanged[0][0]);
    return;
  }

  if (!opts.auto) {
    const go = await vscode.window.showWarningMessage(
      "Versus: the Ollama token estimator is not clamped, so its chars-per-token ratio will " +
        "slide down every tool-heavy turn and shrink the usable window.",
      { modal: true, detail: providers.join("\n") },
      "Apply clamp"
    );
    if (go !== "Apply clamp") return;
  }

  const applied = states
    .filter(([, s]) => s === "patchable")
    .map(([p]) => applyPatch(p))
    .filter((r) => r.changed);

  if (applied.length === 0) return;

  for (const r of applied) {
    log(`estimator clamp applied: ${r.providerPath} — ${r.message}`);
  }

  // The running host still holds the unclamped copy, so this is required, not
  // cosmetic. Say why, or it reads as an optional nag and gets dismissed.
  const action = await vscode.window.showWarningMessage(
    "Versus: the Ollama extension was updated and its token estimator lost the clamp. " +
      "Reapplied — but this session is still running the unclamped copy, so the usable window " +
      "will keep shrinking until the extension host restarts.",
    "Restart Extension Host",
    "Later"
  );
  if (action === "Restart Extension Host") {
    await resetEstimator(log);
  }
}
