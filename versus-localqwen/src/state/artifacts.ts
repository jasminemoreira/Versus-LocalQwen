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

/** A row whose first cell is a module id: the architecture table. */
const MODULE_ROW = /^\s*\|\s*(M-\d+)\s*\|([^|]*)\|/;

/** A row whose first cell is a finding id: the coverage matrix. `M-` is a module. */
const FINDING_ROW = /^\s*\|\s*((?!M-)[A-Za-z]{1,4}-\d+)\s*\|([^|]*)\|/;

/** Module names are compared as written, minus the markup a table picks up. */
export function normalizeModule(name: string): string {
  return name.replace(/[`*_]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

export interface ArchitectureVersion {
  /** null when the doc carries a single unversioned table (the first pass). */
  version: number | null;
  modules: string[];
}

export interface MatrixIteration {
  /** null when the matrix carries no iteration heading at all. */
  iteration: number | null;
  /** Module names as cited by the findings, normalized. */
  modules: string[];
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

/** Module names declared in a `| M-NN | name | … |` table. */
export function parseModuleTable(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = MODULE_ROW.exec(line);
    if (m) out.push(normalizeModule(m[2]));
  }
  return [...new Set(out)].filter(Boolean);
}

/**
 * The architecture doc as a list of versions, oldest first. Phase 3 appends a
 * `## V(N+1)` section per round rather than overwriting, so the last section is
 * the current design and the earlier ones are what earlier findings named.
 */
export function parseArchitectureVersions(text: string): ArchitectureVersion[] {
  const parts = sections(text, /^\s*#{1,6}\s*V\s*\(?(\d+)\)?\b/i);
  const out = parts
    .map((p) => ({ version: p.n, modules: parseModuleTable(p.body) }))
    .filter((v) => v.modules.length > 0);
  return out;
}

/**
 * The coverage matrix as a list of iterations, oldest first. A matrix with no
 * `## Iteração N` heading yields a single section with `iteration: null` — which
 * is exactly the silent collapse the heading exists to prevent, so callers that
 * care about the round should treat null as "unknown", not as 1.
 */
export function parseMatrixIterations(text: string): MatrixIteration[] {
  const parts = sections(text, /^\s*#{1,6}\s*(?:itera[cç][aã]o|iteration)\s*(\d+)/i);
  const out: MatrixIteration[] = [];
  for (const p of parts) {
    const modules: string[] = [];
    const ids: string[] = [];
    for (const line of p.body.split(/\r?\n/)) {
      const m = FINDING_ROW.exec(line);
      if (!m) continue;
      ids.push(m[1]);
      const mod = normalizeModule(m[2]);
      if (mod) modules.push(mod);
    }
    if (ids.length > 0) {
      out.push({ iteration: p.n, modules: [...new Set(modules)], ids });
    }
  }
  return out;
}
