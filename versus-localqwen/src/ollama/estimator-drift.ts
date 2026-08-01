// Detects drift in the chat host's token estimator.
//
// The Ollama VS Code provider does not tokenize. It keeps a running
// chars-per-token ratio per model (CalibratedTokenEstimator) and divides text
// length by it. The ratio is recalibrated after every response:
//
//   observedCharsPerToken = text.length / prompt_eval_count
//   ratio = (ratio + observedCharsPerToken) / 2
//
// The two sides of that division do not measure the same thing. `text.length`
// comes from partToText, which returns '' for tool calls, tool results and
// non-text data parts, whereas prompt_eval_count is the whole prompt Ollama
// tokenized — tool schemas, tool arguments and tool output included.
//
// In an agent-mode session most of the prompt is exactly what partToText drops,
// so the observed ratio collapses far below any real chars-per-token value, and
// the exponential average drags the stored ratio down with it. countTokens then
// divides by a ratio approaching zero and reports conversations several times
// larger than they are, so the host compacts while most of the window is still
// free. Each tool-heavy turn makes it worse, and the ratio only resets when the
// extension host restarts — which is why a fresh chat does not help but
// reloading the window does.
//
// None of that is observable from the server. It is observable by asking the
// host to count a string whose real token count we measured ourselves.

import * as vscode from "vscode";
import {
  CALIBRATION_PROBE,
  DriftReading,
  measureTokens,
} from "./client";

export { CALIBRATION_PROBE, DRIFT_THRESHOLD, DriftReading, effectiveBudget, hasDrifted } from "./client";

/** Consecutive unchanged polls before a session is treated as idle. */
const IDLE_POLLS = 2;

export class DriftDetector {
  /** Measured once per session — the probe is constant, so its cost is too. */
  private trueTokens: number | undefined;
  private lastHostTokens: number | undefined;
  private unchangedPolls = 0;

  constructor(private log: (msg: string) => void) {}

  /** Discards the cached measurement, e.g. when the model changes. */
  reset(): void {
    this.trueTokens = undefined;
    this.lastHostTokens = undefined;
    this.unchangedPolls = 0;
  }

  /**
   * True when no turn has completed for a couple of polls.
   *
   * The provider only recalibrates in `record()`, which runs once a response
   * finishes, so the probe's cost is a free activity signal: if it moved, a
   * turn just ended. Restarting the extension host kills any in-flight request,
   * so this is what keeps the suggestion from landing mid-turn.
   */
  get looksIdle(): boolean {
    return this.unchangedPolls >= IDLE_POLLS;
  }

  /**
   * @param modelIsLoaded Calibration runs two generations. Only do that when
   * the model is already resident, so a background poll never pulls gigabytes
   * of weights into VRAM on its own — and never queues behind, or competes
   * with, a session actively using the GPU.
   */
  async read(
    baseUrl: string,
    modelTag: string,
    modelIsLoaded: boolean
  ): Promise<DriftReading | undefined> {
    if (this.trueTokens === undefined) {
      if (!modelIsLoaded) return undefined;
      const measured = await measureTokens(baseUrl, modelTag, CALIBRATION_PROBE);
      if (measured === null) return undefined;
      this.trueTokens = measured;
      this.log(`calibration probe: ${CALIBRATION_PROBE.length} chars = ${measured} real tokens`);
    }

    let models: readonly vscode.LanguageModelChat[];
    try {
      models = await vscode.lm.selectChatModels({ vendor: "ollama-models" });
    } catch {
      return undefined;
    }
    const model = models.find((m) => m.id === modelTag);
    if (!model) return undefined;

    let hostTokens: number;
    try {
      hostTokens = await model.countTokens(CALIBRATION_PROBE);
    } catch {
      return undefined;
    }
    if (hostTokens <= 0) return undefined;

    if (hostTokens === this.lastHostTokens) {
      this.unchangedPolls += 1;
    } else {
      this.unchangedPolls = 0;
      this.lastHostTokens = hostTokens;
    }

    return {
      hostTokens,
      trueTokens: this.trueTokens,
      factor: hostTokens / this.trueTokens,
      impliedCharsPerToken: CALIBRATION_PROBE.length / hostTokens,
    };
  }
}
