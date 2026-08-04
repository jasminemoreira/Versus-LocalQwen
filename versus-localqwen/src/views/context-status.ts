// Status bar item reporting local-model context health.
//
// The failure this surfaces is invisible by construction: an overflowing prompt
// on an architecture without KV cache shifting produces a clipped prompt and a
// truncated turn, never an error. Nothing in the chat UI marks it. So the
// warning has to come from outside the conversation.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  advertisedBudget,
  Alignment,
  assessAlignment,
  describeWindow,
  effectiveWindow,
  listRunning,
  ModelWindow,
  resolveBudgetFloor,
  RunningModel,
} from "../ollama/client";
import { compareToServer, HostBudget, HostVerdict, readHostBudget } from "../ollama/host-budget";
import { DriftDetector, DriftReading, effectiveBudget, hasDrifted } from "../ollama/estimator-drift";
import { compactionPoint, describeThreshold, readThreshold, Threshold } from "../ollama/compaction";
import { resetEstimator } from "../ollama/reset-estimator";

const POLL_INTERVAL_MS = 15000;

/** Compact token counts for the status bar, which has no room for six digits. */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export interface ContextReading {
  reachable: boolean;
  model: string | null;
  window: ModelWindow | null;
  instance: RunningModel | null;
  alignment: Alignment | null;
  /** What the chat host registered for this model, when it knows it. */
  host: HostBudget | undefined;
  /** Measured host-vs-server comparison. Supersedes `alignment` when known. */
  hostVerdict: HostVerdict;
  /** Whether the host's token estimator has drifted away from the tokenizer. */
  drift: DriftReading | undefined;
  /** Where the host is configured to compact, which is what ends most sessions. */
  threshold: Threshold;
  error?: string;
}

export class ContextStatus implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;
  private last: ContextReading | undefined;
  private warnedForModel: string | null = null;
  private warnedDriftForModel: string | null = null;
  private readonly drift: DriftDetector;
  /**
   * One Ollama server backs every VS Code window, and /api/ps reports whatever
   * is loaded globally. Seeing a second model proves this instance cannot tell
   * which one belongs to its own chat, so from then on it only speaks about a
   * model the user named explicitly.
   */
  private modelsSeen = new Set<string>();

  constructor(private log: (msg: string) => void) {
    this.drift = new DriftDetector(log);
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.command = "versus-localqwen.checkContext";
    this.item.name = "Versus context";
  }

  start(): void {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), POLL_INTERVAL_MS);
  }

  get reading(): ContextReading | undefined {
    return this.last;
  }

  private config() {
    const cfg = vscode.workspace.getConfiguration("versus-localqwen");
    return {
      url: cfg.get<string>("ollamaUrl", "http://127.0.0.1:11434").replace(/\/+$/, ""),
      model: cfg.get<string>("model", ""),
      enabled: cfg.get<boolean>("statusBar", true),
      budgetFloor: cfg.get<number>("usableBudgetFloor", 0.66),
    };
  }

  async refresh(): Promise<ContextReading> {
    const { url, model: configured, enabled } = this.config();

    if (!enabled) {
      this.item.hide();
    }

    let reading: ContextReading;
    try {
      const running = await listRunning(url);
      const model = configured || running[0]?.name || "";
      if (!model) {
        reading = {
          reachable: true,
          model: null,
          window: null,
          instance: null,
          alignment: null,
          host: undefined,
          hostVerdict: { kind: "unknown" },
          drift: undefined,
          threshold: readThreshold(),
        };
      } else {
        this.modelsSeen.add(model);
        const window = await describeWindow(url, model);
        const host = await readHostBudget(model);
        const instance = running.find((m) => m.name === model) ?? null;
        reading = {
          reachable: true,
          model,
          window,
          instance,
          alignment: assessAlignment(window),
          host,
          hostVerdict: compareToServer(host, effectiveWindow(window)),
          drift: await this.drift.read(url, model, instance !== null),
          threshold: readThreshold(),
        };
      }
    } catch (err) {
      reading = {
        reachable: false,
        model: null,
        window: null,
        instance: null,
        alignment: null,
        host: undefined,
        hostVerdict: { kind: "unknown" },
        drift: undefined,
        threshold: readThreshold(),
        error: String(err),
      };
    }

    this.last = reading;
    if (enabled) {
      this.render(reading);
    }
    this.maybeWarn(reading);
    return reading;
  }

  private render(r: ContextReading): void {
    if (!r.reachable) {
      this.item.text = "$(circle-slash) Versus: Ollama off";
      this.item.tooltip = new vscode.MarkdownString(
        "Ollama is unreachable.\n\nIf VS Code runs on Windows and Ollama in WSL, the server is " +
          "likely bound to `127.0.0.1` inside the VM. Point `versus-localqwen.ollamaUrl` at the VM " +
          "IP, or reopen the folder in a WSL remote window."
      );
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.item.show();
      return;
    }

    if (!r.model || !r.window) {
      this.item.text = "$(chip) Versus: no model";
      this.item.tooltip = "No model loaded. Send one message, or set versus-localqwen.model.";
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }

    const real = effectiveWindow(r.window);
    const advertised = advertisedBudget(r.window);
    const spilling =
      r.instance !== null && r.instance.vramBytes > 0 && r.instance.vramBytes < r.instance.sizeBytes;

    const lines = [
      `**${r.model}**`,
      "",
      `Server window: \`${real ?? "unknown"}\``,
      r.host
        ? `Host registered: \`${r.host.maxInputTokens}\` input tokens`
        : `Host will advertise: \`${advertised.input}\` input + \`${advertised.output}\` output ` +
          `(predicted from ${advertised.source} — the host has not registered this model yet)`,
    ];

    if (r.instance) {
      const gpuShare = r.instance.sizeBytes
        ? Math.round((r.instance.vramBytes / r.instance.sizeBytes) * 100)
        : 0;
      lines.push(`In VRAM: \`${gpuShare}%\``);
    }

    lines.push(
      `Compaction threshold: ${describeThreshold(r.threshold, r.host?.maxInputTokens)}`
    );

    if (r.drift) {
      lines.push(
        `Host token estimate: \`${r.drift.factor.toFixed(2)}x\` the real count ` +
          `(${r.drift.impliedCharsPerToken.toFixed(2)} chars/token)`
      );
    }

    const usable = r.drift && r.host ? effectiveBudget(r.host.maxInputTokens, r.drift) : null;
    const floor = resolveBudgetFloor(this.config().budgetFloor, r.host?.maxInputTokens);
    const belowFloor = usable !== null && floor !== null && usable < floor;

    if (belowFloor || hasDrifted(r.drift)) {
      const d = r.drift!;
      // The figure that matters is how much room is left to work in, not the
      // ratio that caused it — so that is what the status bar carries.
      this.item.text = `$(warning) Versus: ${fmtTokens(usable ?? 0)} usable`;
      this.item.backgroundColor = new vscode.ThemeColor(
        belowFloor ? "statusBarItem.errorBackground" : "statusBarItem.warningBackground"
      );
      lines.push(
        "",
        `⚠️ The host counts the probe as **${d.hostTokens}** tokens; the model's tokenizer ` +
          `charges **${d.trueTokens}**, so text is being priced ` +
          `**${d.factor.toFixed(1)}x** too expensive` +
          (usable !== null
            ? `, and the ${r.host!.maxInputTokens}-token budget behaves like **${usable}**.`
            : "."),
        "",
        "The Ollama provider does not tokenize. It keeps a chars-per-token ratio and recalibrates " +
          "it after each response against text that excludes tool calls and tool results. In an " +
          "agent session most of the prompt is exactly what it excludes, so the ratio slides " +
          "further down every tool-heavy turn.",
        "",
        "The ratio lives on the provider instance, not on the chat — a new chat will not help. " +
          "Run **Restart Extension Host** to clear it, between turns: a restart cancels any " +
          "request still streaming."
      );
    } else if (r.hostVerdict.kind === "under") {
      const { hostInput, serverWindow, wastedTokens } = r.hostVerdict;
      this.item.text = `$(warning) Versus: host ${Math.round(hostInput / 1024)}k of ${Math.round(serverWindow / 1024)}k`;
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      lines.push(
        "",
        `⚠️ The host budgets only **${hostInput}** input tokens against a **${serverWindow}** ` +
          `server window, leaving ${wastedTokens} unused. Sessions will compact every few turns ` +
          "while most of the window sits idle, and each compaction costs the context the model " +
          "then re-reads.",
        "",
        "This is almost always a window holding limits captured before the model changed. " +
          "**Reload the window** — the host re-reads the model's limits on startup."
      );
    } else if (r.hostVerdict.kind === "over") {
      const factor = r.hostVerdict.factor.toFixed(1);
      this.item.text = `$(warning) Versus: ctx ${factor}x over`;
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      lines.push(
        "",
        `⚠️ The host budgets **${r.hostVerdict.hostInput}** input tokens against a ` +
          `**${r.hostVerdict.serverWindow}** server window — **${factor}x** too large. Ollama ` +
          "clips the excess instead of failing, and this architecture cannot shift its KV cache, " +
          "so long turns die mid-emission with no error.",
        "",
        "Run **Versus LocalQwen: Align Model Context Window** to fix."
      );
    } else if (r.alignment?.state === "misaligned") {
      const factor = r.alignment.factor!.toFixed(1);
      this.item.text = `$(warning) Versus: ctx ${factor}x over`;
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      lines.push(
        "",
        `⚠️ The chat host budgets prompts **${factor}x larger** than the server can hold. ` +
          "Ollama clips the excess instead of failing, and this architecture cannot shift its KV " +
          "cache — so long turns die mid-emission with no error.",
        "",
        "Run **Versus LocalQwen: Align Model Context Window** to fix."
      );
    } else if (r.alignment?.state === "unpinned") {
      this.item.text = "$(warning) Versus: ctx unpinned";
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      lines.push(
        "",
        "⚠️ This model pins no `num_ctx`, so the host advertises its architectural maximum while " +
          "the server honours only `OLLAMA_CONTEXT_LENGTH`. Send one message to measure the real " +
          "window, or run **Versus LocalQwen: Align Model Context Window**."
      );
    } else if (spilling) {
      this.item.text = "$(warning) Versus: CPU spill";
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      lines.push("", "⚠️ Part of the model is on CPU. Expect a large slowdown.");
    } else {
      const shown = usable ?? (r.hostVerdict.kind === "ok" ? r.hostVerdict.hostInput : real);
      this.item.text = `$(check) Versus: ${fmtTokens(shown ?? 0)} usable`;
      this.item.backgroundColor = undefined;
    }

    this.item.tooltip = new vscode.MarkdownString(lines.join("\n"));
    this.item.show();
  }

  /**
   * Whether this window may interrupt about `model`.
   *
   * Two ways to get it wrong, both seen in practice: warning about a model
   * another window is using, and warning N times because N windows are open.
   * A notification is only honest when the model is attributable to this window
   * AND this window is orchestrating a project that the finding could damage.
   */
  private mayNotifyAbout(model: string): boolean {
    const configured = this.config().model;
    if (configured) return model === configured;
    // Unattributable: more than one model has passed through the shared server.
    if (this.modelsSeen.size > 1) return false;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return false;
    return fs.existsSync(path.join(folder.uri.fsPath, ".versus", "state.json"));
  }

  /** Warns once per model, so a misconfigured setup is not silent on first use. */
  private maybeWarn(r: ContextReading): void {
    if (!r.model || !r.window) return;
    if (!this.mayNotifyAbout(r.model)) {
      this.log(`suppressing notification for ${r.model}: not attributable to this window`);
      return;
    }

    // Drift is warned about separately: it can appear mid-session on a setup
    // that was healthy at startup, so it must not be suppressed by an earlier
    // warning about something else.
    // Drift re-accumulates after every reset, so the warning has to re-arm.
    // Clearing the marker once there is room again means the next slide gets
    // its own warning instead of being silently absorbed.
    const usable =
      r.drift && r.host ? effectiveBudget(r.host.maxInputTokens, r.drift) : null;
    const floor = resolveBudgetFloor(this.config().budgetFloor, r.host?.maxInputTokens);
    const belowFloor = usable !== null && floor !== null && usable < floor;

    if (!belowFloor) {
      this.warnedDriftForModel = null;
    } else if (this.warnedDriftForModel !== r.model) {
      // Restarting the extension host kills an in-flight request, so the offer
      // waits for a gap between turns rather than interrupting one.
      if (!this.drift.looksIdle) return;

      this.warnedDriftForModel = r.model;
      const d = r.drift!;
      this.log(
        `usable budget ${usable} below floor ${floor} ` +
          `(estimator ${d.factor.toFixed(2)}x: ${d.hostTokens} vs ${d.trueTokens})`
      );
      vscode.window
        .showWarningMessage(
          `Versus: ${usable} usable input tokens left of ${r.host!.maxInputTokens} — the ` +
            `provider's token estimate has drifted to ${d.factor.toFixed(1)}x. No turn is in ` +
            `flight, so this is a safe moment to reset it.`,
          "Restart Extension Host",
          "Details"
        )
        .then((action) => {
          if (action === "Restart Extension Host") {
            void resetEstimator(this.log);
          } else if (action === "Details") {
            vscode.commands.executeCommand("versus-localqwen.checkContext");
          }
        });
      return;
    }

    if (this.warnedForModel === r.model) return;

    // A measured host budget is worth warning about even when the inferred
    // alignment looks fine — under-use is invisible to the server-side check.
    if (r.hostVerdict.kind === "under") {
      this.warnedForModel = r.model;
      const { hostInput, serverWindow } = r.hostVerdict;
      this.log(`host under-budgets: ${hostInput} of ${serverWindow} for ${r.model}`);
      vscode.window
        .showWarningMessage(
          `Versus: the chat host budgets only ${hostInput} input tokens for ${r.model}, but the ` +
            `server runs a ${serverWindow} window. Sessions will compact every few turns for no ` +
            `reason. Reload the window so the host re-reads the model's limits.`,
          "Reload Window",
          "Details"
        )
        .then((action) => {
          if (action === "Reload Window") {
            vscode.commands.executeCommand("workbench.action.reloadWindow");
          } else if (action === "Details") {
            vscode.commands.executeCommand("versus-localqwen.checkContext");
          }
        });
      return;
    }

    const overByMeasurement = r.hostVerdict.kind === "over";
    if (!overByMeasurement && (!r.alignment || r.alignment.state === "aligned")) return;
    this.warnedForModel = r.model;

    const message = overByMeasurement
      ? `Versus: the chat host budgets ${(r.hostVerdict as { hostInput: number }).hostInput} input ` +
        `tokens for ${r.model} but the server runs a ${(r.hostVerdict as { serverWindow: number }).serverWindow} ` +
        `window. Prompts will be clipped and long turns will die mid-emission.`
      : r.alignment!.state === "misaligned"
        ? `Versus: ${r.model} advertises ${r.alignment!.advertisedInput} input tokens to the chat ` +
          `host but the server runs a ${r.alignment!.realWindow} window. Prompts will be clipped ` +
          `and long turns will die mid-emission.`
        : `Versus: ${r.model} pins no num_ctx, so the chat host will advertise ` +
          `${r.alignment!.advertisedInput} input tokens regardless of what the server can hold.`;

    this.log(`context warning for ${r.model}: ${message}`);

    vscode.window
      .showWarningMessage(message, "Align now", "Details")
      .then((action) => {
        if (action === "Align now") {
          vscode.commands.executeCommand("versus-localqwen.alignContext");
        } else if (action === "Details") {
          vscode.commands.executeCommand("versus-localqwen.checkContext");
        }
      });
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }
}
