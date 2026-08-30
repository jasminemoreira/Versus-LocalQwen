// Ollama introspection — shared by the MCP server and the extension host.
// Only fetch/JSON, no VS Code or MCP imports, so both bundles can use it.

export interface RunningModel {
  name: string;
  contextLength: number | null;  // the window the runner was actually loaded with
  sizeBytes: number;
  vramBytes: number;
}

export interface ModelWindow {
  /** Window the running instance was loaded with, from /api/ps. Authoritative. */
  loadedWindow: number | null;
  /** num_ctx pinned in the model's parameters, from /api/show. */
  pinnedNumCtx: number | null;
  /** Architectural maximum declared in model_info, e.g. qwen35.context_length. */
  architecturalMax: number | null;
}

/** Mirrors defaultMaxOutputTokens in the Ollama VS Code provider. */
export const PROVIDER_DEFAULT_MAX_OUTPUT = 4096;
/** Mirrors fallbackContextWindow in the Ollama VS Code provider. */
export const PROVIDER_FALLBACK_WINDOW = 32768;

async function getJson(url: string, body?: unknown, timeoutMs = 4000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function listRunning(baseUrl: string): Promise<RunningModel[]> {
  const data = await getJson(`${baseUrl}/api/ps`);
  const models = Array.isArray(data?.models) ? data.models : [];
  return models.map((m: any) => ({
    name: String(m?.name ?? m?.model ?? ""),
    contextLength: typeof m?.context_length === "number" ? m.context_length : null,
    sizeBytes: typeof m?.size === "number" ? m.size : 0,
    vramBytes: typeof m?.size_vram === "number" ? m.size_vram : 0,
  }));
}

export async function listTags(baseUrl: string): Promise<string[]> {
  const data = await getJson(`${baseUrl}/api/tags`);
  const models = Array.isArray(data?.models) ? data.models : [];
  return models.map((m: any) => String(m?.name ?? m?.model ?? "")).filter(Boolean);
}

/**
 * Extracts a numeric PARAMETER from the text blocks /api/show returns.
 * Deliberately the same shape as numericParameterValue in the Ollama provider,
 * so what we read is what VS Code reads.
 */
function numericParameter(text: string | undefined, name: string): number | null {
  if (!text) return null;
  const match = text.match(new RegExp(`^\\s*(?:PARAMETER\\s+)?${name}\\s+(-?\\d+)\\b`, "im"));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function architecturalContextLength(modelInfo: Record<string, unknown> | undefined): number | null {
  if (!modelInfo) return null;
  for (const [key, value] of Object.entries(modelInfo)) {
    if ((key.endsWith(".context_length") || key === "context_length") && typeof value === "number") {
      return value;
    }
  }
  return null;
}

/** The model's attention shape, for deriving what a token of KV cache costs. */
export async function modelInfo(
  baseUrl: string,
  model: string
): Promise<Record<string, unknown> | undefined> {
  const show = await getJson(`${baseUrl}/api/show`, { model });
  return show?.model_info as Record<string, unknown> | undefined;
}

export async function describeWindow(baseUrl: string, model: string): Promise<ModelWindow> {
  const show = await getJson(`${baseUrl}/api/show`, { model });
  const running = await listRunning(baseUrl).catch(() => [] as RunningModel[]);
  const instance = running.find((m) => m.name === model);

  return {
    loadedWindow: instance?.contextLength ?? null,
    pinnedNumCtx:
      numericParameter(show?.parameters, "num_ctx") ??
      numericParameter(show?.modelfile, "num_ctx"),
    architecturalMax: architecturalContextLength(show?.model_info),
  };
}

/**
 * Reproduces the budget the Ollama VS Code extension advertises to the chat
 * host, following the precedence in its sharedContextWindow(): pinned num_ctx,
 * then the architectural context_length, then a 32768 fallback.
 *
 * When num_ctx is not pinned this returns the architectural maximum, which for
 * models like qwen3.6 is several times the window the server actually runs.
 * That gap is what makes the host overfill the prompt.
 */
export function advertisedBudget(win: ModelWindow): { input: number; output: number; source: string } {
  const window =
    win.pinnedNumCtx ??
    win.architecturalMax ??
    PROVIDER_FALLBACK_WINDOW;
  const source = win.pinnedNumCtx
    ? "num_ctx parameter"
    : win.architecturalMax
      ? "model_info context_length"
      : "provider fallback";
  const output = Math.min(PROVIDER_DEFAULT_MAX_OUTPUT, Math.max(0, window - 1));
  return { input: window - output, output, source };
}

/** The window the server will actually honour, best effort. */
export function effectiveWindow(win: ModelWindow): number | null {
  return win.loadedWindow ?? win.pinnedNumCtx ?? null;
}

export type AlignmentState =
  /** Host budget fits inside a window we can prove. */
  | "aligned"
  /** Host budget provably exceeds the window the server loaded. */
  | "misaligned"
  /**
   * Nothing pins the window, so the host will advertise the architectural
   * maximum. Unprovable while the model is unloaded, but the server default
   * (OLLAMA_CONTEXT_LENGTH, 4096 when unset) is never that large — so this is a
   * warning, not an unknown.
   */
  | "unpinned";

export interface Alignment {
  state: AlignmentState;
  advertisedInput: number;
  realWindow: number | null;
  /** How many times larger the host budget is than the real window, when known. */
  factor: number | null;
}

/**
 * Assesses whether the host would pack a prompt larger than the server can hold.
 * On architectures without KV cache shifting the excess is not an overflow
 * error — the prompt is clipped and generation dies mid-emission, so this has
 * to be caught before the request, never after.
 */
export function assessAlignment(win: ModelWindow): Alignment {
  const advertisedInput = advertisedBudget(win).input;
  const realWindow = effectiveWindow(win);

  if (realWindow === null) {
    return {
      state: win.pinnedNumCtx === null ? "unpinned" : "aligned",
      advertisedInput,
      realWindow: null,
      factor: null,
    };
  }

  return {
    state: advertisedInput > realWindow ? "misaligned" : "aligned",
    advertisedInput,
    realWindow,
    factor: advertisedInput / realWindow,
  };
}

/** True when the budget is provably or presumptively wrong. */
export function isMisaligned(win: ModelWindow): boolean {
  return assessAlignment(win).state !== "aligned";
}

/**
 * Token estimate for a text blob. Ollama exposes no tokenizer endpoint, so this
 * is a ratio calibrated against qwen3.6 on markdown and prose: 57473 chars of
 * the Versus guidance tokenized to 13861, i.e. 4.15 chars/token. Rounded down
 * to 4.0 so the estimate errs high — an overestimate costs scope, an
 * underestimate costs the whole turn.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Tokenizes text with the model's real tokenizer.
 *
 * Ollama exposes no /api/tokenize, so this infers the count from
 * prompt_eval_count on a one-token generation, subtracting the cost of an empty
 * message. The chat template wraps both requests identically, so the difference
 * is the text's own token count.
 *
 * The two probes must run SEQUENTIALLY. Ollama reuses a cached prompt prefix
 * between concurrent requests to the same model and then reports only the
 * newly evaluated tokens, which makes the difference meaningless.
 *
 * Two small generations, used to calibrate — not something to call per turn.
 */
export async function measureTokens(
  baseUrl: string,
  model: string,
  text: string
): Promise<number | null> {
  const probe = async (content: string): Promise<number | null> => {
    const data = await getJson(
      `${baseUrl}/api/chat`,
      {
        model,
        messages: [{ role: "user", content }],
        stream: false,
        think: false,
        options: { num_predict: 1 },
      },
      60000
    );
    return typeof data?.prompt_eval_count === "number" ? data.prompt_eval_count : null;
  };

  try {
    const baseline = await probe("");
    if (baseline === null) return null;
    const withText = await probe(text);
    if (withText === null) return null;
    const delta = withText - baseline;
    return delta > 0 ? delta : null;
  } catch {
    return null;
  }
}

export type HostVerdict =
  /** Host budget fits the server window. Nothing to do. */
  | { kind: "ok"; hostInput: number; serverWindow: number }
  /** Host budget exceeds the server window — prompts will be clipped. */
  | { kind: "over"; hostInput: number; serverWindow: number; factor: number }
  /**
   * Host budget is far below the server window. Not dangerous, but it is why a
   * session compacts every few turns while most of the window sits unused —
   * almost always a window that has not been reloaded since the model changed.
   */
  | { kind: "under"; hostInput: number; serverWindow: number; wastedTokens: number }
  /** The host has not registered this model, so there is nothing to compare. */
  | { kind: "unknown" };

/**
 * Under-use only counts as a finding when it is large enough to change
 * behaviour. A few thousand tokens of conservatism is the provider's output
 * reserve doing its job; half the window is a stale registration.
 */
const UNDERUSE_RATIO = 0.75;

export function compareToServer(
  host: { maxInputTokens: number } | undefined,
  serverWindow: number | null
): HostVerdict {
  if (!host || serverWindow === null) return { kind: "unknown" };

  if (host.maxInputTokens > serverWindow) {
    return {
      kind: "over",
      hostInput: host.maxInputTokens,
      serverWindow,
      factor: host.maxInputTokens / serverWindow,
    };
  }

  if (host.maxInputTokens < serverWindow * UNDERUSE_RATIO) {
    return {
      kind: "under",
      hostInput: host.maxInputTokens,
      serverWindow,
      wastedTokens: serverWindow - host.maxInputTokens,
    };
  }

  return { kind: "ok", hostInput: host.maxInputTokens, serverWindow };
}

/**
 * Representative of what a Versus session actually sends: prose, markdown
 * structure and a JSON fragment. Held constant so its measured token count can
 * be cached for the session.
 */
export const CALIBRATION_PROBE = [
  "## Phase 2 — Adversarial Critique",
  "",
  "Apply each lens to the module under review and record every finding with its",
  "severity. A finding is critical when accepting it would ship a defect, important",
  "when it demands an explicit decision, and a suggestion when it can be deferred.",
  "",
  '{"phase":2,"module":"task-repository","lens":"assumptions","severity":"critical"}',
].join("\n");

export interface DriftReading {
  /** What the host says the probe costs. */
  hostTokens: number;
  /** What the model's tokenizer actually charges for it. */
  trueTokens: number;
  /** hostTokens / trueTokens. 1.0 is perfect; above 1 means the host overcounts. */
  factor: number;
  /** Implied chars-per-token the host is currently dividing by. */
  impliedCharsPerToken: number;
}

/**
 * Above this the host is losing enough of the window to change behaviour.
 * Some overcounting is expected and harmless — the provider's default of 4
 * chars/token is already conservative for this model family, which measures
 * around 4.15.
 */
export const DRIFT_THRESHOLD = 1.3;

export function hasDrifted(reading: DriftReading | undefined): boolean {
  return reading !== undefined && reading.factor > DRIFT_THRESHOLD;
}

/**
 * How much of the advertised budget the drift effectively removes. The host
 * still believes it has `maxInputTokens`, but every token it counts costs
 * `factor` of its allowance, so the usable window shrinks by that factor.
 */
export function effectiveBudget(maxInputTokens: number, reading: DriftReading): number {
  return Math.floor(maxInputTokens / reading.factor);
}

/**
 * Resolves the point below which the usable window is worth interrupting over.
 *
 * The raw drift factor is the wrong thing to alert on: 1.3x on a 200k window is
 * irrelevant and 1.3x on a 16k one is fatal. What the operator cares about is
 * how many tokens are actually left to work in, so the floor is expressed that
 * way — as a fraction of the registered budget below 1, or as an absolute token
 * count at 100 and above.
 */
export function resolveBudgetFloor(
  setting: number,
  hostMaxInputTokens: number | undefined
): number | null {
  if (!Number.isFinite(setting) || setting <= 0) return null;
  if (setting >= 100) return Math.floor(setting);
  if (hostMaxInputTokens === undefined) return null;
  return Math.floor(hostMaxInputTokens * setting);
}
