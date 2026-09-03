// Telling apart a tool that puts a question to a person from one that merely
// mentions people.
//
// The first version matched the word "user" anywhere, and nearly every tool
// description says "the user" — "helps the user create project structures",
// "if the user mentions errors". Everything scored as a candidate, the ranking
// became alphabetical noise, and the picker gave no help at all. The signal has
// to be the tool's PURPOSE, which lives in its name and in a few phrases that
// only appear when a tool actually waits for an answer.

export interface ToolLike {
  name: string;
  description?: string;
}

/** A name built around asking: `ask_user`, `confirm`, `promptUser`, `elicit`. */
const ASKING_NAME = /(^|[_\-.\b])(ask|asks|confirm|confirms|prompt|prompts|elicit|inquire)/i;

/**
 * Phrases that appear when a tool waits for a person, and not otherwise.
 * Deliberately whole phrases: "user" alone is in half the tool catalogue.
 */
const ASKING_PHRASE =
  /asks? the (user|human)|prompts? the (user|human)|wait(s|ing)? for (the )?(user|human|answer|response)|(user|human)'?s? (answer|response|reply|choice)|request(s)? (user )?(input|confirmation|approval)|requires? (user )?confirmation|present(s)? (the )?(user|options)/i;

/** True when the tool's own purpose is to put a question to a person. */
export function looksLikeAskTool(tool: ToolLike): boolean {
  return ASKING_NAME.test(tool.name) || ASKING_PHRASE.test(tool.description ?? "");
}

/**
 * The same tools, likely ones first, each group alphabetical.
 *
 * Nothing is filtered out. A harness may name its tool something no pattern
 * anticipates, and hiding it would send the user back to typing a name from
 * memory — the mistake the picker exists to prevent.
 */
export function rankAskTools<T extends ToolLike>(tools: readonly T[]): T[] {
  return [...tools].sort(
    (a, b) =>
      Number(looksLikeAskTool(b)) - Number(looksLikeAskTool(a)) || a.name.localeCompare(b.name)
  );
}
