// Parsing of the specs/ artifacts the gates read.
//
// These are the same shapes the downstream analysis parses, so the tokens are
// part of a contract, not a local convention: the iteration marker is matched by
// `itera[cç][aã]o\s*(\d+)`, the lens declaration by its marker in either
// language, and the architecture version by `V(N)`. Changing a token here
// silently changes what an external reader can see.

/** The lens declaration is accepted in either language — the marker is the join key. */
export const LENS_MARKER = /LENTES\s+ATIVADAS|ACTIVATED\s+LENSES/i;

/**
 * The iteration number. The Portuguese spelling is the one downstream matches,
 * so it is the one the guidance asks for; the English spelling is accepted here
 * rather than rejected, since a build that only fails downstream fails silently.
 */
export const ITERATION_MARK = /itera[cç][aã]o\s*(\d+)|iteration\s*(\d+)/i;

/** The architecture version a declaration or section was written against. */
export const VERSION_MARK = /V\s*\(?(\d+)\)?/i;

/** A row whose first cell is a finding id: the coverage matrix. `M-` is a module. */
const FINDING_ROW = /^\s*\|\s*((?!M-)[A-Za-z]{1,4}-\d+)\s*\|/;

export interface MatrixIteration {
  /** null when the matrix carries no iteration heading at all. */
  iteration: number | null;
  /** Finding ids, in file order. */
  ids: string[];
}

/**
 * Splits a document into sections at headings matching `heading`, keeping the
 * captured number. Text before the first heading becomes a leading `null`
 * section, so a doc with no headings still yields one section holding all of it.
 */
function sections(text: string, heading: RegExp): Array<{ n: number | null; body: string }> {
  const out: Array<{ n: number | null; body: string }> = [{ n: null, body: "" }];
  for (const line of text.split(/\r?\n/)) {
    const m = heading.exec(line);
    if (m) {
      const n = Number(m.find((g, i) => i > 0 && g !== undefined));
      out.push({ n: Number.isFinite(n) ? n : null, body: "" });
    } else {
      out[out.length - 1].body += line + "\n";
    }
  }
  return out;
}

/**
 * The coverage matrix as a list of rounds, oldest first. A matrix with no
 * `## Iteração N` heading yields a single section with `iteration: null` — which
 * is exactly the silent collapse the heading exists to prevent, so callers that
 * care about the round should treat null as "unknown", not as 1.
 */
export function parseMatrixIterations(text: string): MatrixIteration[] {
  const parts = sections(text, /^\s*#{1,6}\s*(?:itera[cç][aã]o|iteration)\s*(\d+)/i);
  const out: MatrixIteration[] = [];
  for (const p of parts) {
    const ids: string[] = [];
    for (const line of p.body.split(/\r?\n/)) {
      const m = FINDING_ROW.exec(line);
      if (m) ids.push(m[1]);
    }
    if (ids.length > 0) {
      out.push({ iteration: p.n, ids });
    }
  }
  return out;
}
