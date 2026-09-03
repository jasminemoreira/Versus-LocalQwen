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
import { bestAskTool, looksLikeAskTool, rankAskTools } from "./ask-tool";
import { advertisedBudget, effectiveWindow, modelInfo } from "./ollama/client";
import { alignModelContext } from "./ollama/align";
import { promptForNumCtx } from "./ollama/align-ui";
import { DEFAULT_HEADROOM_MIB, Fit, fitWindow, kvMiBPerToken, readGpuMemory } from "./ollama/vram";
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


/**
 * The window that fits this GPU, or null when it cannot be computed honestly.
 *
 * Needs three readings and refuses without all of them: free VRAM (nvidia-smi),
 * the window the model is loaded with (the anchor — a projection with no
 * measured starting point is a guess), and the model's attention shape from
 * /api/show, which is what makes the KV cost per token derivable rather than
 * assumed.
 */
async function suggestWindow(
  model: string,
  win: { loadedWindow: number | null; architecturalMax: number | null }
): Promise<Fit | null> {
  try {
    if (!win.loadedWindow) return null;
    const gpu = await readGpuMemory();
    if (!gpu) return null;

    const cfg = vscode.workspace.getConfiguration("versus-localqwen");
    const url = cfg.get<string>("ollamaUrl", "http://127.0.0.1:11434").replace(/\/+$/, "");
    // The server's env, not ours: the extension host does not inherit
    // OLLAMA_KV_CACHE_TYPE from the systemd unit that sets it. Assuming f16
    // overestimates the cost and so errs towards a smaller window.
    const cacheType = cfg.get<string>("kvCacheType", "f16");
    const perToken = kvMiBPerToken(await modelInfo(url, model), cacheType);
    if (perToken === null) return null;

    return fitWindow({
      totalMiB: gpu.totalMiB,
      freeMiB: gpu.freeMiB,
      anchorWindow: win.loadedWindow,
      kvMiBPerToken: perToken,
      headroomMiB: DEFAULT_HEADROOM_MIB,
      maxWindow: win.architecturalMax ?? undefined,
      cacheType,
    });
  } catch {
    return null; // a suggestion is a convenience; never let it break the command
  }
}


/**
 * Persists the choice and offers the reload it needs.
 *
 * Workspace scope when there is one: the same machine runs different models in
 * different windows, and the tool belongs to whichever harness this project
 * talks to. The MCP server reads VERSUS_ASK_USER_TOOL once, when VS Code spawns
 * it, so the choice only reaches the guidance after a restart — better offered
 * than left to be discovered.
 */
async function applyAskUserTool(cfg: vscode.WorkspaceConfiguration, chosen: string): Promise<void> {
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await cfg.update("askUserTool", chosen, target);
  const scope = target === vscode.ConfigurationTarget.Workspace ? "this workspace" : "globally";
  log(`setAskUserTool: ${chosen || "(none)"} for ${scope}`);

  const next = await vscode.window.showInformationMessage(
    chosen
      ? `Versus will ask through '${chosen}' (${scope}).`
      : `Versus will ask through MCP elicitation, the default (${scope}).`,
    "Reload Window"
  );
  if (next === "Reload Window") {
    vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

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
    // Choosing the ask-user tool from a list of tools that exist, rather than
    // from memory. The failure this avoids is specific: a name that is not
    // registered anywhere makes the model call something absent, mid-phase.
    context.subscriptions.push(
      vscode.commands.registerCommand("versus-localqwen.setAskUserTool", async () => {
        const cfg = vscode.workspace.getConfiguration("versus-localqwen");
        const current = cfg.get<string>("askUserTool", "");
        const registered = vscode.lm?.tools ?? [];

        // Tools that plausibly ask a person come first; the rest stay reachable
        // through the filter box.
        const ranked = rankAskTools(registered);

        // With one obvious candidate the question is on or off, not which of
        // forty. The full list stays one keystroke away for the cases it is not.
        const best = bestAskTool(registered);
        if (best && current !== best.name) {
          const answer = await vscode.window.showQuickPick(
            [
              {
                label: `$(check) Yes — ask through '${best.name}'`,
                detail: best.description?.slice(0, 160),
                pick: best.name,
              },
              {
                label: "$(check) No — keep the default (MCP elicitation)",
                detail:
                  "Versus asks through the protocol: the client shows a dialog and the answer comes " +
                  "from you. Where the client cannot, it falls back to a chat block on its own.",
                pick: "",
              },
              {
                label: "$(list-unordered) Choose a different tool…",
                detail: `${registered.length} tools are registered in this window`,
                pick: undefined,
              },
            ],
            {
              title: "Ask the user through a tool?",
              placeHolder: `This window registers '${best.name}' — it asks and waits for an answer.`,
            }
          );
          if (!answer) return;
          if (answer.pick !== undefined) {
            await applyAskUserTool(cfg, answer.pick);
            return;
          }
        }

        type Item = vscode.QuickPickItem & { value?: string; manual?: boolean };
        const items: Item[] = [
          {
            label: "$(check) Default — MCP elicitation",
            description: current === "" ? "current" : undefined,
            detail:
              "Versus asks through the protocol: the client shows a dialog and the answer comes from " +
              "you, not from the model. Falls back to a chat block where the client cannot show one.",
            value: "",
          },
        ];
        const likely = ranked.filter(looksLikeAskTool);
        if (likely.length > 0) {
          items.push({
            label: "Looks like it asks the user",
            kind: vscode.QuickPickItemKind.Separator,
          });
          for (const t of likely) {
            items.push({
              label: `$(comment) ${t.name}`,
              description: t.name === current ? "current" : undefined,
              detail: t.description?.slice(0, 160),
              value: t.name,
            });
          }
        }
        const rest = ranked.filter((t) => !looksLikeAskTool(t));
        if (rest.length > 0) {
          items.push({
            label:
              likely.length > 0
                ? "Everything else registered here"
                : "Registered here — none of them looks like it asks the user",
            kind: vscode.QuickPickItemKind.Separator,
          });
          for (const t of rest) {
            items.push({
              label: `$(tools) ${t.name}`,
              description: t.name === current ? "current" : undefined,
              detail: t.description?.slice(0, 160),
              value: t.name,
            });
          }
        }
        items.push(
          { label: "", kind: vscode.QuickPickItemKind.Separator },
          {
            label: "$(edit) Enter a name manually…",
            detail:
              registered.length === 0
                ? "No tools are registered in this window — the chat extension may not have activated yet."
                : "For a tool this window cannot see, such as one the model's own harness provides.",
            manual: true,
          }
        );

        const picked = await vscode.window.showQuickPick(items, {
          title:
            "Override the ask-user tool? The default (MCP elicitation) needs no setting " +
            "— type to filter",
          placeHolder:
            current === "" ? "Currently: none — questions are asked in chat" : `Currently: ${current}`,
          matchOnDetail: true,
        });
        if (!picked) return;

        let chosen = picked.value;
        if (picked.manual) {
          const typed = await vscode.window.showInputBox({
            title: "Ask-user tool",
            prompt: "Exact tool name. Leave empty to ask questions in chat instead.",
            value: current,
          });
          if (typed === undefined) return;
          chosen = typed.trim();
        }
        if (chosen === undefined || chosen === current) return;

        await applyAskUserTool(cfg, chosen);
      })
    );

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

        const win = r.window ?? { loadedWindow: null, pinnedNumCtx: null, architecturalMax: null };
        const fit = await suggestWindow(model, win);
        if (fit) {
          log(`alignContext: suggesting ${fit.numCtx} — ${fit.explanation}`);
        } else {
          log("alignContext: no suggestion (GPU or model figures unavailable, or the model is not loaded)");
        }
        const numCtx = await promptForNumCtx(effectiveWindow(win), fit);
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
        log,
        context.workspaceState
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

  // The project's own package.json may declare "type":"module", common in
  // modern JS projects. That makes Node treat every .js under the project tree
  // as an ES module — including this CommonJS bundle — which then dies with
  // "require is not defined in ES module scope" and takes the methodology with
  // it, silently. Node resolves module type from the nearest package.json, so
  // one here pins CommonJS for the deploy directory regardless of the project.
  const pkgPath = path.join(targetDir, "package.json");
  const pkgContent = JSON.stringify({ type: "commonjs" }, null, 2) + "\n";
  if (!fs.existsSync(pkgPath) || fs.readFileSync(pkgPath, "utf-8") !== pkgContent) {
    fs.writeFileSync(pkgPath, pkgContent);
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
      VERSUS_ASK_USER_TOOL: "${config:versus-localqwen.askUserTool}",
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
