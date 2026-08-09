// MCP Tool: the lens set of one critique round, as state instead of prose.

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { StateEngine } from "../../state/engine";
import { CONDITIONAL_LENSES, canonicalLens, isConditionalLens } from "../../rules/lenses";

export const recordActivatedLensesTool: Tool = {
  name: "record_activated_lenses",
  description:
    "Records the conditional lens set for THIS round of Phase 2, before critiquing. " +
    "All 12 conditional lenses must be accounted for: activated, or not activated with " +
    "its own reason. Replaces the prose declaration and is required to advance 2→3. " +
    "Each round of the 2↔3 loop records its own set — the previous one does not carry over.",
  inputSchema: {
    type: "object" as const,
    properties: {
      conditional: {
        type: "array",
        description: "Conditional lenses ACTIVATED for this round, by canonical name.",
        items: { type: "string", enum: [...CONDITIONAL_LENSES] },
      },
      notActivated: {
        type: "array",
        description:
          "Conditional lenses NOT activated, each with an individual reason. " +
          "'Not applicable' is not a reason — say which project signal is absent. " +
          "Redundancy with another lens is never a reason: activation is by project signal only.",
        items: {
          type: "object",
          properties: {
            lens: { type: "string", enum: [...CONDITIONAL_LENSES] },
            reason: { type: "string" },
          },
          required: ["lens", "reason"],
        },
      },
    },
    required: ["conditional", "notActivated"],
  },
};

interface NotActivated {
  lens: string;
  reason: string;
}

/**
 * Canonicalizes a list against the 12 conditional lenses. The universal 7 are
 * refused here even though `canonicalLens` accepts all 19: the count of
 * conditional lenses is a measured variable, and a universal smuggled into it
 * inflates that count while passing the completeness check.
 */
function resolveConditional(raw: unknown, field: string): { names: string[]; errors: string[] } {
  const errors: string[] = [];
  const names: string[] = [];
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    const text = String(item ?? "").trim();
    const c = canonicalLens(text);
    if (!c) {
      errors.push(
        `${field}: '${text}' is not a lens name. Use the canonical spelling — a translation or an ` +
        `abbreviation is a different name to every reader downstream.`
      );
      continue;
    }
    if (!isConditionalLens(c)) {
      errors.push(
        `${field}: '${c}' is a UNIVERSAL lens, and the universal 7 always apply — they are not ` +
        `declared here. Only the 12 conditional lenses are.`
      );
      continue;
    }
    if (names.includes(c)) {
      errors.push(`${field}: '${c}' appears twice. One entry per lens.`);
      continue;
    }
    names.push(c);
  }
  return { names, errors };
}

export function handleRecordActivatedLenses(
  engine: StateEngine,
  args: { conditional?: unknown; notActivated?: unknown }
): string {
  if (!engine.getPhaseState()) {
    return JSON.stringify({ error: "Project not initialized. Call init_project first." });
  }

  const activated = resolveConditional(args.conditional, "conditional");
  const errors = [...activated.errors];

  const rawNot = Array.isArray(args.notActivated) ? (args.notActivated as NotActivated[]) : [];
  const refused = resolveConditional(
    rawNot.map((n) => n?.lens),
    "notActivated"
  );
  errors.push(...refused.errors);

  refused.names.forEach((lens, i) => {
    const reason = String(rawNot[i]?.reason ?? "").trim();
    if (!reason) {
      errors.push(
        `notActivated: '${lens}' has no reason. Each refusal carries its own justification — that ` +
        `text is the evidence for whether the lens should have run.`
      );
    }
  });

  // A lens cannot be both. The record would contradict itself, and whichever
  // branch a reader trusted would be the wrong one half the time.
  const both = activated.names.filter((l) => refused.names.includes(l));
  if (both.length > 0) {
    errors.push(
      `${both.join(", ")}: declared as activated AND as not activated. A lens is one or the other.`
    );
  }

  const accounted = new Set([...activated.names, ...refused.names]);
  const missing = CONDITIONAL_LENSES.filter((l) => !accounted.has(l));
  if (missing.length > 0) {
    errors.push(
      `Not accounted for: ${missing.join(", ")}. All 12 conditional lenses must appear — activated, ` +
      `or not activated with a reason. Absence of findings is a valid result, so silence about a ` +
      `lens is not the same as deciding about it.`
    );
  }

  if (errors.length > 0) {
    return JSON.stringify({
      success: false,
      error: "The lens declaration was not recorded.",
      problems: errors,
    });
  }

  const entry = engine.recordActivatedLenses(
    activated.names,
    refused.names.map((lens, i) => ({ lens, reason: String(rawNot[i].reason).trim() }))
  );

  return JSON.stringify({
    success: true,
    iteration: entry.iteration,
    againstVersion: entry.againstVersion,
    activated: entry.conditional,
    notActivatedCount: entry.notActivated.length,
    message:
      `Lens set recorded for iteration ${entry.iteration}, against architecture V(${entry.againstVersion}). ` +
      `The universal 7 apply as always.`,
    nextStep:
      `Head this round's findings in specs/design/coverage-matrix.md with ` +
      `'## Iteração ${entry.iteration} — V(${entry.againstVersion})', keeping the previous rounds below ` +
      `it. The lens column of each finding must be a canonical name, and a conditional one must be in ` +
      `the set just recorded.`,
  });
}
