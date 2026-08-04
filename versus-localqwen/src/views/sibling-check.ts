// Detects sibling Versus MCP servers registered in the same workspace.
//
// The Versus extensions install side by side and each registers its own MCP
// server exposing the same ~15 tool names. Two registrations mean the model
// receives both sets: the schemas are re-sent on every request, so a duplicate
// costs roughly 2500 tokens per turn on a window where that is 4% of the whole
// budget — and worse, two tools with the same name and different backing
// servers give the model a choice it has no basis to make.
//
// This does not clean up on its own: the other file belongs to another
// extension, which would rewrite it anyway. Coexistence is a deliberate design
// choice in the Versus family, so this reports once and then stays out of the
// way — a permanent, accepted condition is not something to interrupt about on
// every activation.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const OURS = "versus-localqwen";
const SIBLING_PREFIX = "versus-";

export interface SiblingRegistration {
  /** Server name as registered, e.g. "versus-claude". */
  name: string;
  /** Config file it came from, workspace-relative. */
  source: string;
  /** Absolute path of the server the entry points at. */
  target: string | undefined;
}

function readServers(file: string, key: "servers" | "mcpServers"): Record<string, any> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    const block = parsed?.[key];
    return block && typeof block === "object" ? block : {};
  } catch {
    return {};
  }
}

export function findSiblings(workspace: string): SiblingRegistration[] {
  const sources: Array<{ file: string; key: "servers" | "mcpServers"; label: string }> = [
    { file: path.join(workspace, ".vscode", "mcp.json"), key: "servers", label: ".vscode/mcp.json" },
    { file: path.join(workspace, ".mcp.json"), key: "mcpServers", label: ".mcp.json" },
  ];

  const found: SiblingRegistration[] = [];
  for (const { file, key, label } of sources) {
    if (!fs.existsSync(file)) continue;
    for (const [name, config] of Object.entries(readServers(file, key))) {
      if (!name.startsWith(SIBLING_PREFIX) || name === OURS) continue;
      const args = (config as any)?.args;
      found.push({
        name,
        source: label,
        target: Array.isArray(args) && typeof args[0] === "string" ? args[0] : undefined,
      });
    }
  }
  return found;
}

/**
 * A sibling pointed at our own bundle path is the dangerous case: the two
 * extensions overwrite one binary and the host ends up advertising one
 * extension's tools while another's server answers. Tool calls then fail with
 * errors that name neither.
 */
export function sharesOurBundle(siblings: SiblingRegistration[], ourServerPath: string): boolean {
  const ourDir = path.dirname(ourServerPath);
  return siblings.some((s) => s.target && path.dirname(s.target) === path.dirname(ourDir));
}

/** Remembered per workspace, so an accepted condition stops interrupting. */
const DISMISS_KEY = "versus-localqwen.siblingWarningDismissed";

export function reportSiblings(
  workspace: string,
  ourServerPath: string,
  log: (msg: string) => void,
  memento: vscode.Memento
): void {
  const siblings = findSiblings(workspace);
  if (siblings.length === 0) return;

  const names = siblings.map((s) => `${s.name} (${s.source})`).join(", ");
  // Always on the record, whether or not it interrupts.
  log(`sibling Versus MCP servers registered: ${names}`);

  if (memento.get<boolean>(DISMISS_KEY)) return;

  const detail =
    siblings.map((s) => `${s.name}\n  from ${s.source}\n  → ${s.target ?? "unknown"}`).join("\n\n") +
    "\n\nWhether this costs anything depends on the sibling being enabled in this window. If it " +
    "is, its tool schemas are re-sent on every request — roughly 2500 tokens — and duplicate tool " +
    "names leave the model choosing between them with nothing to go on. VS Code's MCP view shows " +
    "which servers are actually running.\n\nVersus keeps its state in .versus/state.json, shared " +
    "across the family, so nothing is lost by disabling the ones you are not using here.";

  vscode.window
    .showInformationMessage(
      `Versus: ${siblings.length} other Versus MCP ${siblings.length === 1 ? "server is" : "servers are"} ` +
        `registered in this workspace (${siblings.map((s) => s.name).join(", ")}).`,
      "Details",
      "Open config",
      "Don't show again"
    )
    .then((action) => {
      if (action === "Details") {
        vscode.window.showInformationMessage("Duplicate Versus registrations", { modal: true, detail });
      } else if (action === "Open config") {
        const first = siblings[0];
        const file = first.source === ".mcp.json" ? ".mcp.json" : path.join(".vscode", "mcp.json");
        vscode.window.showTextDocument(vscode.Uri.file(path.join(workspace, file)));
      } else if (action === "Don't show again") {
        void memento.update(DISMISS_KEY, true);
        log("sibling warning dismissed for this workspace");
      }
    });
}
