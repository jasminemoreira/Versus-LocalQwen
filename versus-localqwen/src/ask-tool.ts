// Ranking the host's tools by how likely each is to put a question to a person.
//
// Kept apart from the command that shows the picker so it can be tested without
// an extension host: the picker is a list, and the part worth getting right is
// which entries reach the top of it. A window can register dozens of tools.

export interface ToolLike {
  name: string;
  description?: string;
}

/** Names and descriptions of a tool that asks someone something. */
const ASKS_A_PERSON = /ask|question|prompt|confirm|input|user|human|choice|select/i;

/**
 * The same tools, with the plausible ones first and each group alphabetical.
 *
 * Nothing is filtered out. A harness may name its tool something this pattern
 * never anticipated, and hiding it would send the user to the manual entry box —
 * back to typing a name from memory, which is the mistake the picker exists to
 * prevent.
 */
export function rankAskTools<T extends ToolLike>(tools: readonly T[]): T[] {
  const score = (t: ToolLike) => (ASKS_A_PERSON.test(`${t.name} ${t.description ?? ""}`) ? 0 : 1);
  return [...tools].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
}
