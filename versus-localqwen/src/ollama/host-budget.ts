// What the chat host itself believes the model's budget is.
//
// Everything else in this extension reasons about the *server's* window. That
// is only half the picture: the host packs prompts against the limit it
// registered for the model, and those two numbers drift apart for reasons the
// server cannot see — a stale window holding limits captured before a modelfile
// changed, an /api/show call that failed during discovery and fell through to
// the provider's 32768 default, a model added to the picker under different
// settings.
//
// vscode.lm.selectChatModels reports the registered limit directly, so the
// comparison becomes a measurement instead of a reconstruction.

import * as vscode from "vscode";

export interface HostBudget {
  /** Model id as the host knows it, normally the Ollama tag. */
  id: string;
  maxInputTokens: number;
  vendor: string;
  family: string;
}

/**
 * Reads the registered budget for a model tag. Returns undefined when the
 * host has no such model — typically because the picker has not been opened
 * yet, since providers are only asked for models on demand.
 */
export async function readHostBudget(modelTag: string): Promise<HostBudget | undefined> {
  let models: readonly vscode.LanguageModelChat[];
  try {
    models = await vscode.lm.selectChatModels({ vendor: "ollama-models" });
  } catch {
    return undefined;
  }

  const match =
    models.find((m) => m.id === modelTag) ??
    models.find((m) => m.name === modelTag) ??
    models.find((m) => m.id.startsWith(modelTag.split(":")[0]));

  if (!match) return undefined;

  return {
    id: match.id,
    maxInputTokens: match.maxInputTokens,
    vendor: match.vendor,
    family: match.family,
  };
}

export { compareToServer, HostVerdict } from "./client";
