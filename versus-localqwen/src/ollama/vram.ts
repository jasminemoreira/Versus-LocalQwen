// Sizing the context window against the GPU that will actually hold it.
//
// The extension used to propose 65536 to everyone, because that is what this
// machine sustains. On a 24 GB card the same number leaves ~1.8 GB for the
// desktop, and a heavier desktop pushes the KV cache out to system RAM — where
// generation drops by 20-50x and the session reads as frozen, with no error
// anywhere. Pinning num_ctx is what puts the user on that edge: without the pin
// Ollama would have chosen a smaller window on its own.
//
// So the suggestion is computed, and the arithmetic is shown, rather than
// asserted from one machine's experience.

import { execFile } from "child_process";

export interface GpuMemory {
  totalMiB: number;
  freeMiB: number;
}

/**
 * Total and free VRAM, or null when it cannot be read.
 *
 * nvidia-smi is the only portable-enough source here: this build targets Ollama
 * on NVIDIA, and the extension host can run it. A null means "do not guess" —
 * callers fall back to asking rather than to a number they cannot justify.
 */
export function readGpuMemory(): Promise<GpuMemory | null> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits"],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const first = String(stdout).trim().split(/\r?\n/)[0] ?? "";
        const [total, free] = first.split(",").map((n) => Number(n.trim()));
        if (!Number.isFinite(total) || !Number.isFinite(free)) return resolve(null);
        resolve({ totalMiB: total, freeMiB: free });
      }
    );
  });
}

/** Bytes per element of the KV cache, by the OLLAMA_KV_CACHE_TYPE in force. */
export function kvBytesPerElement(cacheType: string | undefined): number {
  switch ((cacheType ?? "f16").trim().toLowerCase()) {
    case "q4_0":
      return 0.5;
    case "q8_0":
      return 1;
    default:
      return 2; // f16
  }
}

/**
 * KV cache cost of one token, in MiB, derived from what /api/show publishes.
 *
 * Only layers with full attention keep a KV cache. A hybrid model declares this
 * as `full_attention_interval`: qwen35 has 64 blocks at interval 4, so 16 layers
 * pay for the cache and the window is four times cheaper than the usual formula
 * predicts. Getting that wrong would make every suggestion far too small.
 *
 * The 1.06 factor is the quantised cache's scale overhead, measured: the formula
 * gives 2048 MiB at 65536 tokens where llama.cpp reports 2176.
 */
export function kvMiBPerToken(
  modelInfo: Record<string, unknown> | undefined,
  cacheType: string | undefined
): number | null {
  if (!modelInfo) return null;
  const num = (suffix: string): number | null => {
    for (const [k, v] of Object.entries(modelInfo)) {
      if ((k.endsWith(`.${suffix}`) || k === suffix) && typeof v === "number") return v;
    }
    return null;
  };

  const blocks = num("block_count");
  const kvHeads = num("attention.head_count_kv");
  const headDim = num("attention.key_length");
  if (!blocks || !kvHeads || !headDim) return null;

  const interval = num("full_attention_interval");
  const fullLayers = interval && interval > 1 ? Math.floor(blocks / interval) : blocks;
  if (fullLayers < 1) return null;

  const bytesPerToken = 2 * fullLayers * kvHeads * headDim * kvBytesPerElement(cacheType);
  return (bytesPerToken / (1024 * 1024)) * 1.06;
}

export interface FitInput {
  /** VRAM the card has in total. For the explanation, not the decision. */
  totalMiB: number;
  /** VRAM free RIGHT NOW, measured with the model loaded at `anchorWindow`. */
  freeMiB: number;
  /** The window the running instance was loaded with. */
  anchorWindow: number;
  /**
   * KV cost per token, for the cache type CURRENTLY loaded. Changing
   * OLLAMA_KV_CACHE_TYPE invalidates the anchor — the free reading was taken
   * under the old one — so a projection across cache types is not a projection.
   */
  kvMiBPerToken: number;
  /** Margin to keep free on top of everything already in use, for the desktop to grow into. */
  headroomMiB: number;
  /** The model's architectural ceiling, when known. Nothing above it is offerable. */
  maxWindow?: number;
  /** Named in the explanation, since the whole slope depends on it. */
  cacheType?: string;
}

export interface Fit {
  numCtx: number;
  /** VRAM projected to remain free at that window. */
  freeAtWindowMiB: number;
  /** The arithmetic, for a human to check rather than trust. */
  explanation: string;
}

/** Windows are proposed in familiar sizes; an odd number reads as a guess. */
const LADDER = [4096, 8192, 16384, 32768, 49152, 65536, 98304, 131072, 262144];

/** How much VRAM to leave for the desktop to grow into, beyond what it holds now. */
export const DEFAULT_HEADROOM_MIB = 2048;

/**
 * The largest window on the ladder that still leaves `headroomMiB` free.
 *
 * Deliberately built from observable quantities only: free VRAM as it stands,
 * and the KV delta between the loaded window and the candidate. Nothing has to
 * be attributed to the model — not the weights, not the compute buffers, not the
 * fixed recurrent state a hybrid model carries (748 MiB here, which no window
 * size recovers). Whatever they are, they are already inside the free reading.
 *
 * Requires the model to be loaded: without a real anchor there is no honest
 * projection, and a suggestion that cannot be justified is worse than none.
 */
export function fitWindow(input: FitInput): Fit | null {
  const { totalMiB, freeMiB, anchorWindow, kvMiBPerToken: perToken, headroomMiB } = input;
  if (!(perToken > 0) || anchorWindow <= 0) return null;

  const freeAt = (window: number) => freeMiB - (window - anchorWindow) * perToken;

  const ceiling = input.maxWindow && input.maxWindow > 0 ? input.maxWindow : Infinity;
  let chosen: number | null = null;
  for (const window of LADDER) {
    if (window <= ceiling && freeAt(window) >= headroomMiB) chosen = window;
  }
  if (chosen === null) return null;

  const free = Math.round(freeAt(chosen));
  const delta = chosen - anchorWindow;
  const move =
    delta === 0
      ? `the window it already runs`
      : delta > 0
        ? `${delta} tokens more than the ${anchorWindow} it runs now`
        : `${-delta} tokens less than the ${anchorWindow} it runs now`;
  return {
    numCtx: chosen,
    freeAtWindowMiB: free,
    explanation:
      `${totalMiB} MiB on the card, ${freeMiB} MiB free with the model loaded at ${anchorWindow}. ` +
      `${chosen} tokens is ${move}, and should leave ~${free} MiB free — above the ${headroomMiB} MiB ` +
      `kept for the desktop. KV costs ~${perToken.toFixed(4)} MiB per token for this model` +
      `${input.cacheType ? `, assuming a ${input.cacheType} cache` : ""}.`,
  };
}
