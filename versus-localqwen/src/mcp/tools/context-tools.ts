// MCP Tool: context budget guard for local models.
//
// Exists because the failure this guards against is silent. On hybrid attention
// architectures (qwen3.5/3.6 and relatives) the KV cache cannot be partially
// evicted, so llama.cpp disables context shifting. There is no sliding window,
// no overflow error and no exception the host could catch: when the prompt
// fills the window the prompt is clipped and generation stops mid-emission.
// A turn ending in prose where a tool call belonged is the visible symptom.

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  advertisedBudget,
  assessAlignment,
  describeWindow,
  effectiveWindow,
  estimateTokens,
  listRunning,
  listTags,
  PROVIDER_DEFAULT_MAX_OUTPUT,
} from "../../ollama/client";

function baseUrl(): string {
  return (process.env.VERSUS_OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
}

function configuredModel(): string {
  return process.env.VERSUS_OLLAMA_MODEL || "";
}

function generationReserve(): number {
  const raw = Number(process.env.VERSUS_GENERATION_RESERVE);
  return Number.isFinite(raw) && raw > 0 ? raw : PROVIDER_DEFAULT_MAX_OUTPUT;
}

export const checkContextBudgetTool: Tool = {
  name: "check_context_budget",
  description:
    "Reports the real context window of the local Ollama model and whether the chat host is " +
    "budgeting against it correctly. Call this BEFORE any turn expected to emit a file, a full " +
    "critique, a coverage matrix or a long table.\n\n" +
    "This model's architecture has no KV cache shifting: when the prompt fills the window, " +
    "generation stops mid-emission with no error. There is nothing to catch and nothing to retry. " +
    "The only defence is refusing the round in advance and narrowing the scope.\n\n" +
    "If the response has ok=false, DO NOT attempt the work. Report the reason to the user and " +
    "propose a smaller unit — one function instead of one file, one lens instead of all lenses.",
  inputSchema: {
    type: "object" as const,
    properties: {
      planned_chars: {
        type: "number",
        description:
          "Rough size in characters of what you are about to emit or read in this turn. " +
          "Omit if unknown; the window facts are still returned.",
      },
      intent: {
        type: "string",
        description: "One line on what the turn is meant to produce. Echoed back for the log.",
      },
    },
    required: [],
  },
};

export async function handleCheckContextBudget(args: {
  planned_chars?: number;
  intent?: string;
}): Promise<string> {
  const url = baseUrl();
  const reserve = generationReserve();

  let model = configuredModel();
  let running: Awaited<ReturnType<typeof listRunning>> = [];
  try {
    running = await listRunning(url);
  } catch (err) {
    return JSON.stringify({
      ok: false,
      reachable: false,
      ollamaUrl: url,
      error: `Ollama unreachable at ${url}: ${String(err)}`,
      action:
        "Cannot verify the context budget. If VS Code runs on Windows and Ollama in WSL, the " +
        "server is probably bound to 127.0.0.1 inside the VM — point versus-localqwen.ollamaUrl " +
        "at the VM IP or reopen the folder in a WSL remote window.",
    });
  }

  if (!model) {
    model = running[0]?.name ?? "";
  }
  if (!model) {
    const tags = await listTags(url).catch(() => [] as string[]);
    model = tags[0] ?? "";
  }
  if (!model) {
    return JSON.stringify({
      ok: false,
      reachable: true,
      ollamaUrl: url,
      error: "No model loaded and no model tags available.",
      action: "Send one message to the model first, or set versus-localqwen.model.",
    });
  }

  const win = await describeWindow(url, model).catch(() => null);
  if (!win) {
    return JSON.stringify({
      ok: false,
      reachable: true,
      ollamaUrl: url,
      model,
      error: `/api/show failed for ${model}.`,
      action: "Confirm the model tag exists (ollama list).",
    });
  }

  const instance = running.find((m) => m.name === model);
  const advertised = advertisedBudget(win);
  const real = effectiveWindow(win);
  const alignment = assessAlignment(win);

  // Only the loaded window is a hard fact. Without it the safe budget is
  // whatever the host will advertise, which may be far too generous.
  const safeInputTokens = real === null ? null : Math.max(0, real - reserve);
  const plannedTokens =
    typeof args.planned_chars === "number" && args.planned_chars > 0
      ? estimateTokens(args.planned_chars)
      : null;

  const problems: string[] = [];
  if (alignment.state === "misaligned") {
    problems.push(
      `The chat host will budget ${advertised.input} input tokens (source: ${advertised.source}) ` +
        `while the server runs a ${real} window. Prompts are being built against a budget ` +
        `${alignment.factor!.toFixed(1)}x too large, so they are silently clipped to fit — and ` +
        `the clip discards tool definitions first.`
    );
  } else if (alignment.state === "unpinned") {
    problems.push(
      `${model} pins no num_ctx, so the chat host will advertise its architectural maximum ` +
        `(${advertised.input} input tokens). The server will honour only OLLAMA_CONTEXT_LENGTH, ` +
        `which defaults to 4096. Load the model once to measure the real window, or pin num_ctx.`
    );
  }
  if (plannedTokens !== null && safeInputTokens !== null && plannedTokens > safeInputTokens) {
    problems.push(
      `The planned ${plannedTokens} tokens exceed the ${safeInputTokens} token safe budget on their own.`
    );
  }
  if (instance && instance.vramBytes > 0 && instance.vramBytes < instance.sizeBytes) {
    const gpuShare = Math.round((instance.vramBytes / instance.sizeBytes) * 100);
    problems.push(
      `Only ${gpuShare}% of the model is in VRAM; the remainder runs on CPU. Expect a large ` +
        `slowdown. Reduce the window or close other GPU consumers.`
    );
  }

  const ok = problems.length === 0;

  return JSON.stringify({
    ok,
    reachable: true,
    ollamaUrl: url,
    model,
    intent: args.intent,
    window: {
      loadedByServer: win.loadedWindow,
      pinnedNumCtx: win.pinnedNumCtx,
      architecturalMax: win.architecturalMax,
      hostWillAdvertiseInput: advertised.input,
      hostWillAdvertiseOutput: advertised.output,
      advertisedFrom: advertised.source,
      alignment: alignment.state,
    },
    budget: {
      generationReserve: reserve,
      safeInputTokens,
      plannedTokens,
    },
    fullyOnGpu: instance ? instance.vramBytes >= instance.sizeBytes : null,
    problems,
    action: ok
      ? "Budget is sound. Proceed, but still emit one artifact in this turn — not several."
      : alignment.state !== "aligned"
        ? "STOP. Tell the user to run the command 'Versus LocalQwen: Align Model Context Window', " +
          "which pins PARAMETER num_ctx on the model so the host budgets against the real window. " +
          "Until then, every long turn is at risk of dying mid-emission."
        : "STOP. Do not attempt this turn. Report the reason above and propose a smaller unit.",
  });
}
