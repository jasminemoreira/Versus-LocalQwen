// Finding the tool that puts a question to a person, among everything a window
// happens to register.
//
// Two mistakes are already behind this file. Matching the word "user" anywhere
// caught nearly every tool, because descriptions say "the user" constantly.
// Matching phrases in descriptions then caught `open_browser_page` and
// `run_in_terminal`, whose text mentions prompts and confirmations in passing.
// The reliable signal is the NAME: a tool built to ask is named for it, and a
// tool that merely talks about users is not.

export interface ToolLike {
  name: string;
  description?: string;
}

/** Asks a question and waits for an answer — the thing the methodology needs. */
const ASKS_A_QUESTION = /(^|[_.\-])(ask|asks|question|questions|choice|choices|elicit|inquire)/i;

/** Asks for approval. Adjacent, usable, but a yes/no is not a question with options. */
const ASKS_APPROVAL = /(^|[_.\-])(confirm|confirms|confirmation|prompt|prompts)/i;

/**
 * How well a tool fits "put this question to the user and wait".
 *
 * 2 = named for asking questions, 1 = named for confirmations, 0 = neither.
 * Descriptions are deliberately not consulted: they are prose about a tool, and
 * every attempt to read intent out of them has produced false candidates.
 */
export function askToolScore(tool: ToolLike): 0 | 1 | 2 {
  if (ASKS_A_QUESTION.test(tool.name)) return 2;
  if (ASKS_APPROVAL.test(tool.name)) return 1;
  return 0;
}

/** True for anything worth offering as the ask-user tool. */
export function looksLikeAskTool(tool: ToolLike): boolean {
  return askToolScore(tool) > 0;
}

/**
 * The single obvious candidate, or null when the choice is not obvious.
 *
 * Null means either nothing qualifies or several tie at the top, and both cases
 * deserve the full list rather than a confident guess. When one tool scores
 * above all others, the question stops being "which of forty" and becomes
 * on or off — which is what it should have been from the start.
 */
export function bestAskTool<T extends ToolLike>(tools: readonly T[]): T | null {
  const scored = tools.map((t) => ({ tool: t, score: askToolScore(t) })).filter((s) => s.score > 0);
  if (scored.length === 0) return null;
  const top = Math.max(...scored.map((s) => s.score));
  const leaders = scored.filter((s) => s.score === top);
  return leaders.length === 1 ? leaders[0].tool : null;
}

/**
 * The same tools, best fit first, each group alphabetical.
 *
 * Nothing is filtered out. A harness may name its tool something no pattern
 * anticipates, and hiding it would send the user back to typing a name from
 * memory — the mistake the picker exists to prevent.
 */
export function rankAskTools<T extends ToolLike>(tools: readonly T[]): T[] {
  return [...tools].sort(
    (a, b) => askToolScore(b) - askToolScore(a) || a.name.localeCompare(b.name)
  );
}
