// Clearing the provider's drifted token estimate.
//
// The ratio lives on the Ollama provider instance, so it dies with the
// extension host and not with the chat session. Restarting the extension host
// is therefore enough, and it is much cheaper than reloading the window: no
// renderer teardown, editors and terminals survive.

import * as vscode from "vscode";

const RESTART_EXTENSION_HOST = "workbench.action.restartExtensionHost";
const RELOAD_WINDOW = "workbench.action.reloadWindow";

/**
 * Restarts the extension host, falling back to a full window reload if the
 * command is unavailable in this build.
 */
export async function resetEstimator(log: (msg: string) => void): Promise<void> {
  const commands = await vscode.commands.getCommands(true);
  if (commands.includes(RESTART_EXTENSION_HOST)) {
    log("resetting provider estimate via extension host restart");
    await vscode.commands.executeCommand(RESTART_EXTENSION_HOST);
    return;
  }
  log("restartExtensionHost unavailable — falling back to window reload");
  await vscode.commands.executeCommand(RELOAD_WINDOW);
}
