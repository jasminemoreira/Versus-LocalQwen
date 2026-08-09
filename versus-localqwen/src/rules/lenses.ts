// The 19 lenses as data, so the lens name stops being prose.
//
// The name is a join key: matrices from different projects only aggregate if the
// lens is written the same way in all of them. Guidance said so from 0.5.x on,
// but nothing read the column — a finding carrying `Sustainability` instead of
// `Sustainability / Proportionality` passed every gate and cost a whole project
// slot upstream (T21). This file is the single source those checks read.

/** Always applied — all 7, every round. */
export const UNIVERSAL_LENSES = [
  "Assumptions",
  "Architectural",
  "Implementability",
  "Scientific",
  "Security",
  "Performance",
  "Regulatory",
] as const;

/** Activated on project signal — 8 situational + 4 Domain Transfer Lenses. */
export const CONDITIONAL_LENSES = [
  "Resilience",
  "UI/UX",
  "Migration / Coexistence",
  "Sustainability / Proportionality",
  "Ethical / Human Impact",
  "Process / Workflow",
  "Governance / Accountability",
  "Observability / Operability",
  "Control Engineering",
  "Game Theory",
  "Linguistics / Grammar",
  "Mechanical Engineering",
] as const;

export const ALL_LENSES: readonly string[] = [...UNIVERSAL_LENSES, ...CONDITIONAL_LENSES];

/**
 * A finding that fits no lens is recorded under this literal rather than
 * squeezed into the nearest one — the §4 channel, and the only value besides a
 * canonical name the matrix accepts.
 */
export const NO_LENS = "NENHUMA";

/** Case and the spacing around a slash are noise; anything else is a different name. */
function normalize(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ");
}

const BY_NORMALIZED = new Map(ALL_LENSES.map((l) => [normalize(l), l]));

/**
 * The canonical spelling of `raw`, or null if it is not a lens.
 *
 * Tolerates case and `UI / UX` for `UI/UX`. Deliberately intolerant of
 * translations and abbreviations: `Segurança` and `SEG` are not `Security`, and
 * accepting them would make the aggregate silently wrong instead of loudly
 * blocked. Truncation is the same kind of error — `Sustainability` is not
 * `Sustainability / Proportionality`.
 */
export function canonicalLens(raw: string): string | null {
  if (!raw) return null;
  return BY_NORMALIZED.get(normalize(raw)) ?? null;
}

/** True when the canonical name is one of the 12 conditional lenses. */
export function isConditionalLens(canonical: string): boolean {
  return (CONDITIONAL_LENSES as readonly string[]).includes(canonical);
}
