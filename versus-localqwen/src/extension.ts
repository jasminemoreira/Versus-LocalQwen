// Extension Core — lifecycle, component registration, local-model bootstrap

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawnSync } from "child_process";
import { SidebarProvider } from "./views/sidebar";
import { ContextStatus } from "./views/context-status";
import { reportSiblings } from "./views/sibling-check";
import { ensureEstimatorClamp } from "./views/estimator-patch-ui";
import { ensureSpecsReadme, AGENT_INSTRUCTIONS_CONTENT } from "./setup";
import { advertisedBudget, effectiveWindow } from "./ollama/client";
import { alignModelContext } from "./ollama/align";
import { promptForNumCtx } from "./ollama/align-ui";
import { effectiveBudget, hasDrifted } from "./ollama/estimator-drift";
import { resetEstimator } from "./ollama/reset-estimator";
import {
  compactionPoint,
  describeThreshold,
  promptForThreshold,
  readThreshold,
  writeThreshold,
} from "./ollama/compaction";

// Kept in step with BUNDLE_DIR in mcp/tools/project-tools.ts: siblings must not
// overwrite each other's server binary in a shared workspace.
const BUNDLE_DIR = "localqwen";

const SPECS_SUBDIRS = [
  "references", "domain", "technical", "examples", "design",
  "models", "datasets", "validation", "competitors",
];

let sidebarProvider: SidebarProvider | undefined;
let contextStatus: ContextStatus | undefined;
let outputChannel: vscode.OutputChannel;

function log(msg: string) {
  outputChannel?.appendLine(`[Versus] ${new Date().toISOString()} ${msg}`);
}

function checkPrerequisites(): boolean {
  const missing: string[] = [];
  const nodeOk = (() => {
    const r = spawnSync("node", ["--version"], { encoding: "utf-8" });
    return r.status === 0 && !r.error;
  })();
  // The Ollama provider registers the local model with the chat host. Without
  // it there is no model to run the methodology on. Chat itself ships in core
  // since VS Code 1.104, so no Copilot subscription is required.
  const ollamaOk = !!vscode.extensions.getExtension("Ollama.ollama");

  if (!nodeOk) {
    missing.push("**Node.js** — install from https://nodejs.org/en/download and restart VSCode.");
  }
  if (!ollamaOk) {
    missing.push(
      "**Ollama** (publisher: Ollama, verified) — the language model provider that exposes your " +
        "local models to VS Code chat. Beware of unverified look-alikes with the same llama icon."
    );
  }

  if (missing.length > 0) {
    const msg = `Versus LocalQwen requires the following to work:\n${missing.join("\n")}\nThe extension will not function until these are installed.`;
    const buttons: string[] = [];
    if (!nodeOk) buttons.push("Download Node.js");
    if (!ollamaOk) buttons.push("Open Marketplace");
    vscode.window.showErrorMessage(msg, ...buttons).then((action) => {
      if (action === "Download Node.js") {
        vscode.env.openExternal(vscode.Uri.parse("https://nodejs.org/en/download"));
      } else if (action === "Open Marketplace") {
        vscode.commands.executeCommand("workbench.extensions.search", "@id:Ollama.ollama");
      }
    });
    return false;
  }

  return true;
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Versus for Local Qwen");
  context.subscriptions.push(outputChannel);
  log("Activating extension...");

  if (!checkPrerequisites()) {
    log("Prerequisites missing — activation aborted.");
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    log("No workspace open — activation aborted.");
    return;
  }

  const workspacePath = workspaceFolders[0].uri.fsPath;
  const extensionPath = context.extensionPath;
  log(`Workspace: ${workspacePath}`);
  log(`Extension path: ${extensionPath}`);

  try {
    // Register TreeView sidebar
    sidebarProvider = new SidebarProvider(workspacePath);
    const treeView = vscode.window.createTreeView("versus-localqwen.phaseView", {
      treeDataProvider: sidebarProvider,
      showCollapseAll: true,
    });
    context.subscriptions.push(treeView);
    log("TreeView registered.");

    // Command: manual refresh
    context.subscriptions.push(
      vscode.commands.registerCommand("versus-localqwen.refreshView", () => {
        sidebarProvider?.refresh();
      })
    );
    log("Command refreshView registered.");

    // The clamp lives in the Ollama extension's files, so an update to it wipes
    // the patch no matter what this workspace contains. Checked before the
    // telemetry starts, so the first reading reflects the state we just left.
    const autoPatch = vscode.workspace
      .getConfiguration("versus-localqwen")
      .get<boolean>("autoPatchOllamaEstimator", true);
    if (autoPatch) {
      void ensureEstimatorClamp(log, { auto: true });
    }

    context.subscriptions.push(
      vscode.commands.registerCommand("versus-localqwen.patchEstimator", () =>
        ensureEstimatorClamp(log, { auto: false, announceNoop: true })
      )
    );

    // Context health telemetry — the overflow it watches for is silent, so it
    // has to be reported from outside the conversation.
    contextStatus = new ContextStatus(log);
    context.subscriptions.push(contextStatus);
    contextStatus.start();
    log("Context status started.");

    context.subscriptions.push(
      vscode.commands.registerCommand("versus-localqwen.checkContext", async () => {
        const r = await contextStatus!.refresh();
        if (!r.reachable) {
          vscode.window.showErrorMessage(
            "Ollama is unreachable. If VS Code runs on Windows and Ollama in WSL, set " +
              "versus-localqwen.ollamaUrl to the VM IP, or reopen the folder in a WSL remote window."
          );
          return;
        }
        if (!r.model || !r.window) {
          vscode.window.showInformationMessage(
            "No model loaded. Send one message in chat, or set versus-localqwen.model."
          );
          return;
        }
        const real = effectiveWindow(r.window);
        const adv = advertisedBudget(r.window);
        const detail =
          `Server window: ${real ?? "unknown"}\n` +
          (r.host
            ? `Host registered: ${r.host.maxInputTokens} input tokens (measured)\n`
            : `Host predicted: ${adv.input} input + ${adv.output} output (from ${adv.source}) — ` +
              `the host has not registered this model yet\n`) +
          `Architectural max: ${r.window.architecturalMax ?? "unknown"}\n` +
          `Pinned num_ctx: ${r.window.pinnedNumCtx ?? "none"}\n` +
          `Compaction threshold: ${describeThreshold(r.threshold, r.host?.maxInputTokens)}\n` +
          (r.drift
            ? `Host token estimate: ${r.drift.factor.toFixed(2)}x real ` +
              `(${r.drift.hostTokens} vs ${r.drift.trueTokens} on the probe)\n`
            : "") +
          `Verdict: ${
            hasDrifted(r.drift)
              ? "estimator drifted"
              : r.hostVerdict.kind === "unknown"
                ? r.alignment?.state ?? "unknown"
                : r.hostVerdict.kind
          }`;

        // Drift decides first — it shrinks the usable window no matter how well
        // the advertised budget matches the server.
        if (hasDrifted(r.drift)) {
          const usable = r.host ? effectiveBudget(r.host.maxInputTokens, r.drift!) : null;
          const action = await vscode.window.showWarningMessage(
            `${r.model}: the host counts tokens ${r.drift!.factor.toFixed(1)}x too expensive` +
              (usable !== null ? `, so its budget behaves like ${usable} tokens.` : "."),
            { modal: true, detail },
            "Restart Extension Host"
          );
          if (action === "Restart Extension Host") {
            await resetEstimator(log);
          }
          return;
        }

        // Under-use is the compaction-loop case: nothing is clipped, but the
        // host gives up most of the window, so a reload is the fix — not a
        // realignment of the model.
        if (r.hostVerdict.kind === "under") {
          const action = await vscode.window.showWarningMessage(
            `${r.model}: the host is using ${Math.round(
              (r.hostVerdict.hostInput / r.hostVerdict.serverWindow) * 100
            )}% of the available window, so sessions compact far earlier than they need to.`,
            { modal: true, detail },
            "Reload Window"
          );
          if (action === "Reload Window") {
            vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        } else if (r.hostVerdict.kind === "over" || (r.alignment && r.alignment.state !== "aligned")) {
          const action = await vscode.window.showWarningMessage(
            r.hostVerdict.kind === "over" || r.alignment?.state === "misaligned"
              ? `${r.model}: the chat host budgets prompts larger than the server can hold.`
              : `${r.model}: no num_ctx is pinned, so the host budget is unverifiable.`,
            { modal: true, detail },
            "Align now"
          );
          if (action === "Align now") {
            vscode.commands.executeCommand("versus-localqwen.alignContext");
          }
        } else {
          vscode.window.showInformationMessage(`${r.model}: context budget aligned.`, {
            modal: true,
            detail,
          });
        }
      })
    );

    // Auto-compaction is the single largest lever on a small window: the host
    // summarises before the window is full, and on a 64k model that headroom is
    // most of the session.
    context.subscriptions.push(
      vscode.commands.registerCommand("versus-localqwen.setCompactionThreshold", async () => {
        const r = await contextStatus!.refresh();
        const budget = r.host?.maxInputTokens;
        const current = readThreshold();

        const value = await promptForThreshold(budget);
        if (value === undefined) return;

        const setting = await writeThreshold(value);
        const point = compactionPoint(readThreshold(), budget ?? 0);
        log(`compaction threshold: ${describeThreshold(current, budget)} -> ${value} (${setting})`);
        vscode.window.showInformationMessage(
          `Versus: compaction threshold set to ${value}` +
            (point ? ` — the host will compact around ${point} tokens.` : ".") +
            " Applies to new chat sessions."
        );
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("versus-localqwen.alignContext", async () => {
        const r = await contextStatus!.refresh();
        const model =
          r.model ??
          (await vscode.window.showInputBox({ prompt: "Model tag to align", placeHolder: "qwen3.6:27b" }));
        if (!model) return;

        const numCtx = await promptForNumCtx(effectiveWindow(r.window ?? { loadedWindow: null, pinnedNumCtx: null, architecturalMax: null }));
        if (numCtx === undefined) return;

        const confirmed = await vscode.window.showWarningMessage(
          `Rewrite the tag '${model}' with num_ctx pinned to ${numCtx}?`,
          {
            modal: true,
            detail:
              "This rebuilds the model's manifest in place. The weights blob is referenced by " +
              "digest, so nothing is re-downloaded and no disk space is duplicated — but the " +
              "existing tag is replaced. Any parameter you set on it by hand is preserved.",
          },
          "Rewrite tag"
        );
        if (confirmed !== "Rewrite tag") return;

        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Aligning ${model}...` },
          () => alignModelContext(model, numCtx)
        );

        log(`alignContext: ${result.ok ? "ok" : "failed"} — ${result.message}`);
        if (!result.ok) {
          vscode.window.showErrorMessage(`Versus: ${result.message}`);
          return;
        }
        await contextStatus!.refresh();
        const next = await vscode.window.showInformationMessage(
          `Versus: ${result.message}`,
          "Reload Window"
        );
        if (next === "Reload Window") {
          vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      })
    );
    log("Context commands registered.");

    // Command: initialize project (Copilot bootstrap)
    context.subscriptions.push(
      vscode.commands.registerCommand("versus-localqwen.initProject", async () => {
        const name = await vscode.window.showInputBox({
          prompt: "Project name",
          placeHolder: "my-project",
        });
        if (!name) return;

        const description = await vscode.window.showInputBox({
          prompt: "Brief description",
          placeHolder: "Project description...",
        });
        if (!description) return;

        try {
          // Check if already exists
          const { StateEngine } = await import("./state/engine");
          const engine = new StateEngine(workspacePath);
          const existing = engine.getPhaseState();
          if (existing) {
            vscode.window.showWarningMessage(
              `Project '${existing.projectName}' already exists (Phase ${existing.currentPhase}).`
            );
            return;
          }

          // 1. Create state.json
          engine.initProject(name, description);
          log("initProject: state.json created.");

          // 2. Deploy server.js (MCP server) to .versus/
          deployServer(extensionPath, workspacePath);

          // 3. Create specs/ and subdirectories
          createSpecs(workspacePath);

          // 4. Generate .vscode/mcp.json (Copilot MCP discovery)
          generateMcpConfig(workspacePath);

          // 5. Generate .github/copilot-instructions.md
          generateAgentInstructions(workspacePath);

          // 6. Configure .vscode/settings.json
          generateVscodeSettings(workspacePath);

          sidebarProvider?.refresh();
          vscode.window.showInformationMessage(
            `Project '${name}' initialized. Phase 0 — Problem Discovery. Open VS Code Agent Mode (Ctrl+Shift+I) to continue. Tip: type "retomar Versus" in chat anytime to recover methodology context.`
          );
          vscode.window.showWarningMessage(
            `⚠️ If VS Code Agent Mode is already open, close and reopen it so it discovers the MCP server (.vscode/mcp.json was just created).`
          );
          vscode.window.showWarningMessage(
            `⚠️ Populate ./specs/ before starting Phase 0 — the AI reads from there. Key dirs: domain, references, technical, examples.`,
            "Open specs/"
          ).then((action) => {
            if (action === "Open specs/") {
              vscode.commands.executeCommand(
                "revealInExplorer",
                vscode.Uri.file(path.join(workspacePath, "specs"))
              );
            }
          });
          log("initProject: completed successfully.");
        } catch (err) {
          log(`initProject ERROR: ${String(err)}`);
          vscode.window.showErrorMessage(`Versus: Error initializing project: ${String(err)}`);
        }
      })
    );
    log("Command initProject registered.");

    // On activation: only update server.js and MCP config (keeps sync with extension version)
    const stateExists = fs.existsSync(path.join(workspacePath, ".versus", "state.json"));
    if (stateExists) {
      deployServer(extensionPath, workspacePath);
      log("server.js updated.");
      generateMcpConfig(workspacePath);
      log("MCP config updated.");
      reportSiblings(
        workspacePath,
        path.join(workspacePath, ".versus", BUNDLE_DIR, "server.js"),
        log
      );
    } else {
      log("No Versus project in this workspace — nothing to do on activation.");
    }

    log("Activation completed successfully.");
  } catch (err) {
    log(`ACTIVATION ERROR: ${String(err)}`);
    vscode.window.showErrorMessage(`Versus: Activation error — ${String(err)}`);
  }
}

/** Copies server.js (MCP server) from the extension to .versus/ of the workspace */
function deployServer(extensionPath: string, workspacePath: string) {
  const src = path.join(extensionPath, "out", "bundle", "server.js");
  if (!fs.existsSync(src)) return;

  const targetDir = path.join(workspacePath, ".versus", BUNDLE_DIR);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const dest = path.join(targetDir, "server.js");
  const srcContent = fs.readFileSync(src);
  const destContent = fs.existsSync(dest) ? fs.readFileSync(dest) : null;

  if (!destContent || !srcContent.equals(destContent)) {
    fs.writeFileSync(dest, srcContent);
  }
}

/** Creates specs/ with 9 subdirectories + README.md */
function createSpecs(workspacePath: string) {
  const specsDir = path.join(workspacePath, "specs");
  if (!fs.existsSync(specsDir)) {
    for (const sub of SPECS_SUBDIRS) {
      fs.mkdirSync(path.join(specsDir, sub), { recursive: true });
    }
  }
  ensureSpecsReadme(workspacePath);
}

/** Generates .vscode/mcp.json for VS Code Agent Mode to discover the MCP server */
function generateMcpConfig(workspacePath: string) {
  const serverPath = path.join(workspacePath, ".versus", BUNDLE_DIR, "server.js");
  if (!fs.existsSync(serverPath)) return;

  const vscodeDir = path.join(workspacePath, ".vscode");
  const vscodeMcpPath = path.join(vscodeDir, "mcp.json");
  if (!fs.existsSync(vscodeDir)) {
    fs.mkdirSync(vscodeDir, { recursive: true });
  }

  const vscodeMcp = readJsonSafe(vscodeMcpPath, { servers: {} });
  vscodeMcp.servers = vscodeMcp.servers || {};
  // ${config:...} is resolved by VS Code at server launch, so the MCP process
  // tracks the user's settings without this file being rewritten.
  vscodeMcp.servers["versus-localqwen"] = {
    command: "node",
    args: [serverPath],
    env: {
      VERSUS_OLLAMA_URL: "${config:versus-localqwen.ollamaUrl}",
      VERSUS_OLLAMA_MODEL: "${config:versus-localqwen.model}",
      VERSUS_GENERATION_RESERVE: "${config:versus-localqwen.generationReserve}",
    },
  };

  fs.writeFileSync(vscodeMcpPath, JSON.stringify(vscodeMcp, null, 2), "utf-8");
}

/** Configures .vscode/settings.json with tool auto-approve for agent mode */
function generateVscodeSettings(workspacePath: string) {
  const vscodeDir = path.join(workspacePath, ".vscode");
  const settingsPath = path.join(vscodeDir, "settings.json");

  if (!fs.existsSync(vscodeDir)) {
    fs.mkdirSync(vscodeDir, { recursive: true });
  }

  let settings: Record<string, any> = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch { settings = {}; }
  }

  let changed = false;
  if (settings["chat.tools.autoApprove"] !== true) {
    settings["chat.tools.autoApprove"] = true;
    changed = true;
  }
  if (settings["github.copilot.chat.codeGeneration.useInstructionFiles"] !== true) {
    settings["github.copilot.chat.codeGeneration.useInstructionFiles"] = true;
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  }
}

/**
 * Generates .github/copilot-instructions.md — the instruction file VS Code chat
 * loads into every request. Content is shared with the MCP server's own writer
 * so the two can never disagree.
 */
function generateAgentInstructions(workspacePath: string) {
  const githubDir = path.join(workspacePath, ".github");
  const instructionsPath = path.join(githubDir, "copilot-instructions.md");

  if (fs.existsSync(instructionsPath)) {
    const content = fs.readFileSync(instructionsPath, "utf-8");
    if (content.includes("versus")) return;
  }

  if (!fs.existsSync(githubDir)) {
    fs.mkdirSync(githubDir, { recursive: true });
  }

  if (fs.existsSync(instructionsPath)) {
    const existing = fs.readFileSync(instructionsPath, "utf-8");
    fs.writeFileSync(instructionsPath, existing + "\n" + AGENT_INSTRUCTIONS_CONTENT, "utf-8");
  } else {
    fs.writeFileSync(instructionsPath, AGENT_INSTRUCTIONS_CONTENT, "utf-8");
  }
}

function readJsonSafe(filePath: string, fallback: Record<string, any>): Record<string, any> {
  if (!fs.existsSync(filePath)) return { ...fallback };
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return { ...fallback };
  }
}

export function deactivate() {
  sidebarProvider?.dispose();
  contextStatus?.dispose();
}
