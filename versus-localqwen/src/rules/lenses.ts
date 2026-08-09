// The 19 lenses as data, so the lens name stops being prose.
//
// The name is a join key: matrices from different projects only aggregate if the
// lens is written the same way in all of them. Guidance said so from 0.5.x on,
// but nothing read the column — a finding carrying `Sustainability` instead of
// `Sustainability / Proportionality` passed every gate and cost a whole project
// slot upstream (T21). This file is the single source those checks read.
//
// It is also the single source the guidance RENDERS from. The central question,
// the failure class and the trigger used to be hand-written markdown in the
// Phase 2 guidance — a second copy of names this file already owned, and exactly
// where a trigger edit could drift from what the gate validates.

export interface LensDef {
  /** Canonical name — what the gates and the tool enum compare against. */
  name: string;
  /** Central question, in generative mode. */
  question: string;
  /** The failure class no other lens detects. */
  failureClass: string;
  /** When to activate. Conditional lenses only; the universal 7 always apply. */
  trigger?: string;
  /** Which conditional table the lens is rendered in. */
  group?: "situational" | "dtl";
}

/** Always applied — all 7, every round. */
export const UNIVERSAL_LENS_DEFS: LensDef[] = [
  {
    name: "Assumptions",
    question: "What does this design assume as true without declaring?",
    failureClass: "Failures from hidden assumptions",
  },
  {
    name: "Architectural",
    question: "Can each module be replaced, removed, or tested in isolation?",
    failureClass: "Hidden coupling, circular dependencies, SRP violation",
  },
  {
    name: "Implementability",
    question: "Can I code this module in a single session with available context?",
    failureClass: "Incomplete specs, insufficient granularity",
  },
  {
    name: "Scientific",
    question: "Does each value/formula/algorithm have a verifiable bibliographic reference?",
    failureClass: "Invented parameters, plausibility-based logic",
  },
  {
    name: "Security",
    question: "How would an attacker exploit this with minimal effort?",
    failureClass: "Unanalyzed attack surface",
  },
  {
    name: "Performance",
    question: "Where are the bottlenecks? Asymptotic behavior?",
    failureClass: "Hidden bottlenecks, degradation at scale",
  },
  {
    name: "Regulatory",
    question: "Does each normative requirement have traceability to a module?",
    failureClass: "Non-compliance with applicable standards",
  },
];

/** Activated on project signal — 8 situational + 4 Domain Transfer Lenses. */
export const CONDITIONAL_LENS_DEFS: LensDef[] = [
  {
    name: "Resilience",
    question: "What happens when an external dependency fails, responds slowly, or returns unexpected data?",
    failureClass: "Cascading failures, retry storms, partial outages",
    trigger:
      "External dependencies (APIs, DBs, queues, third-party services)",
    group: "situational",
  },
  {
    name: "UI/UX",
    question: "Can the user complete their task without frustration, confusion, or error?",
    failureClass: "Confusing flows, dead-end states, missing feedback, accessibility failures",
    trigger:
      "Any surface a PERSON operates — including a CLI or operational tooling, not only graphical end-user interfaces",
    group: "situational",
  },
  {
    name: "Migration / Coexistence",
    question: "What breaks during the transition from old to new? Is there a rollback path?",
    failureClass: "Data loss in migration, functional regression vs. legacy, impossible rollback",
    trigger:
      "Replacing or modifying existing production system",
    group: "situational",
  },
  {
    name: "Sustainability / Proportionality",
    question: "Is resource consumption proportionate to value delivered? Cost at 10× scale?",
    failureClass: "GPU where CPU suffices, heavy model for simple task, infinite data retention",
    trigger:
      "The system decides, allocates, or consumes a resource whose cost grows with use — e.g. (but NOT only) AI/ML, high-volume data processing, elastic infrastructure. Apply the central question, do not just match the examples",
    group: "situational",
  },
  {
    name: "Ethical / Human Impact",
    question: "Who is potentially harmed? Are there audit, correction, and transparency mechanisms?",
    failureClass: "Algorithmic bias, digital exclusion, automated decisions without human recourse",
    trigger:
      "Automated decisions about people (scoring, classification, moderation)",
    group: "situational",
  },
  {
    name: "Process / Workflow",
    question: "Are processes, state transitions, actor responsibilities, and exception paths complete?",
    failureClass: "Orphaned states, ambiguous handoffs, missing actors, happy-path bias",
    trigger:
      "Multi-actor flows, state machines, or business processes",
    group: "situational",
  },
  {
    name: "Governance / Accountability",
    question: "Is every action attributable? Does every data entity have a defined owner?",
    failureClass: "No data ownership, no accountability, shadow data flows",
    trigger:
      "The system records or decides something someone will later need to audit, attribute, or answer for — data with distinct owners, actions that need authorship, or an obligation to account. This is a SYSTEM property: a single-operator project activates it when the system has it (not only multi-team / compliance contexts)",
    group: "situational",
  },
  {
    name: "Observability / Operability",
    question: "Can degradation be detected and incidents diagnosed in production without code changes?",
    failureClass: "Opaque systems where nobody can figure out why it failed",
    trigger:
      "Production systems with operational requirements",
    group: "situational",
  },
  {
    name: "Control Engineering",
    question: "Where does the system generate error signal and correct? Risk of oscillation or state drift?",
    failureClass: "Systems that react to events but don't regulate state",
    trigger:
      "State synchronization, runtime configuration, feedback loops, systems that must converge to a target",
    group: "dtl",
  },
  {
    name: "Game Theory",
    question: "Do actors have aligned incentives? Where does the system assume cooperation but may encounter strategic defection?",
    failureClass: "Architectures that collapse under adversarial/strategic behavior",
    trigger:
      "Multiple independent actors, public API consumed externally, marketplace or multi-tenant systems",
    group: "dtl",
  },
  {
    name: "Linguistics / Grammar",
    question: "Is the interface contract unambiguous? Can two correct implementations be mutually incompatible?",
    failureClass: "Protocol ambiguity — two correct implementations that are mutually incompatible",
    trigger:
      "Inter-component communication contracts, interfaces defined between independent teams",
    group: "dtl",
  },
  {
    name: "Mechanical Engineering",
    question: "Where are the tolerances? Does the system tolerate variation or only work at exact specification?",
    failureClass: "Rigid coupling disguised as tolerance — fails on small variations",
    trigger:
      "Module maintenance, long-lived systems, technical debt, systems expected to evolve or be replaced",
    group: "dtl",
  },
];

// Derived, never a second hand-written list: a name can only be wrong here by
// being wrong in the definition the guidance shows the model.
export const UNIVERSAL_LENSES: string[] = UNIVERSAL_LENS_DEFS.map((l) => l.name);
export const CONDITIONAL_LENSES: string[] = CONDITIONAL_LENS_DEFS.map((l) => l.name);
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
  return CONDITIONAL_LENSES.includes(canonical);
}

/** Renders a lens table exactly as the Phase 2 guidance used to spell it by hand. */
export function renderLensTable(defs: LensDef[], withTrigger: boolean): string {
  const header = withTrigger
    ? "| Lens | Central Question | Exclusive Failure Class | Activate when... |\n|------|-----------------|------------------------|------------------|"
    : "| Lens | Central Question | Exclusive Failure Class |\n|------|-----------------|------------------------|";
  const rows = defs.map((l) =>
    withTrigger
      ? `| ${l.name} | ${l.question} | ${l.failureClass} | ${l.trigger} |`
      : `| ${l.name} | ${l.question} | ${l.failureClass} |`
  );
  return [header, ...rows].join("\n");
}

/** The 8 situational conditional lenses, in guidance order. */
export const SITUATIONAL_LENS_DEFS = CONDITIONAL_LENS_DEFS.filter((l) => l.group === "situational");

/** The 4 Domain Transfer Lenses, which the guidance presents in their own table. */
export const DTL_LENS_DEFS = CONDITIONAL_LENS_DEFS.filter((l) => l.group === "dtl");
