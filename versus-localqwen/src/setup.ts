// Shared setup utilities — no external dependencies (only fs/path).
// Used by both extension.ts (VS Code context) and mcp/tools/project-tools.ts (MCP context).

import * as fs from "fs";
import * as path from "path";

const SPECS_README_CONTENT = `# specs/ — Material de referência para a metodologia

O assistente (Claude/Copilot/Qwen) lê destes diretórios durante as fases
0-7. Popule com conteúdo do seu projeto antes de iniciar cada fase.

## Como operar o Versus

**Retomar contexto:** digite \`retomar Versus\` no chat. O assistente
recarrega a fase atual, decisões e instruções. Use sempre que o chat
perder contexto (reinício do VSCode, conversa longa, trocou de modelo).

**MCP não foi descoberto:** se você já tinha o chat aberto quando
inicializou o projeto, feche e reabra — o MCP server só é detectado ao
iniciar uma nova sessão.

## Subdiretórios

- **domain/** — conhecimento de domínio, glossário, regras de negócio, invariantes
- **references/** — papers, artigos, documentação externa citada no design
- **technical/** — algoritmos, fórmulas, parâmetros numéricos com fontes
- **examples/** — implementações de referência (para port em S6 Tier 2)
- **design/** — mockups, wireframes, referências de UX
- **models/** — modelos de domínio, modelos de dados, relacionamentos
- **datasets/** — dados de teste, entradas de exemplo, saídas esperadas
- **validation/** — critérios de aceitação, cenários de teste, métricas de sucesso
- **competitors/** — produtos similares analisados em P0

## Qual pasta alimenta qual fase

- **Fase 0-1:** domain, references, technical, competitors
- **Fase 1:** + examples, design, models
- **Fase 5:** technical, examples, models, datasets
- **Fase 6:** validation, datasets
`;

/**
 * Writes specs/README.md if it does not already exist.
 * Never overwrites — respects user customizations.
 * Returns true if the file was created.
 */
export function ensureSpecsReadme(workspace: string): boolean {
  const readmePath = path.join(workspace, "specs", "README.md");
  if (fs.existsSync(readmePath)) return false;
  const specsDir = path.dirname(readmePath);
  if (!fs.existsSync(specsDir)) {
    fs.mkdirSync(specsDir, { recursive: true });
  }
  fs.writeFileSync(readmePath, SPECS_README_CONTENT, "utf-8");
  return true;
}

// Shared by the extension host and the MCP server so the two can never drift.
export const AGENT_INSTRUCTIONS_CONTENT = `## Iterative Convergence Methodology (Versus)

This project uses the Versus methodology orchestrated via MCP server \`versus-localqwen\`.

### MANDATORY in every interaction:

1. **Always** call \`get_phase_state\` first to know the current phase
2. Call \`get_phase_guidance\` to get detailed phase instructions
3. If no project is initialized, ask the user if they want to create one with \`init_project\`
4. Record every important decision with \`record_decision\`
5. Before advancing phases, use \`get_exit_criteria\` to check pending items and \`advance_phase\` to transition

### User interaction:

Every decision the methodology says belongs to the user goes to the user — never
decide one yourself, and never write a question and keep going.

**HOW to ask is decided at run time, and rule R2 in the phase guidance says which
way. Follow R2, not a format remembered from anywhere else.** Where the host can
show a dialog, R2 names the tool to call and a chat block would be a downgrade;
where it cannot, R2 gives the block format to write instead. This file is written
once, when the project is created, and cannot know which of the two applies —
which is why it does not spell out a format.

Whichever way R2 names: one question at a time, options with the recommended one
first, and STOP after asking. Continuing past an unanswered question is deciding
it alone.
- Mark recommended option with **(Recommended)**
- Options must be contextualized to the project — never generic
- After the response, record with \`record_decision\`

### General rules:

- NEVER skip phases — the methodology is sequential (Phase 0 → 7)
- NEVER implement code before Phase 5
- In Phases 5-6, call \`record_test_outcome\` after EVERY test run. There are no hooks
  watching your shell here, so an unreported run is an uncounted one, and S6 goes blind
- Every architectural decision must be recorded
- Consult \`get_decisions\` to retrieve previous decisions
- Use \`check_all_safeguards\` before phase transitions

### Context discipline (local model — read this before every long turn):

You are running on a local model whose context window is small and, on hybrid
attention architectures, **cannot degrade gracefully**. When the prompt fills the
window there is no sliding, no error and no exception: generation simply stops
mid-emission. A turn that ends with "I'll create the files now!" and no tool call
is almost always overflow, not confusion. Treat it as a failure, never as success.

- Call \`check_context_budget\` before any turn expected to emit a file, a full
  critique or a long table. If it reports \`ok: false\`, say so and narrow the
  scope instead of trying and dying halfway.
- **One artifact per turn.** One file, one module, one lens. Never batch.
- NEVER re-read a file already in the conversation. Cite it from context.
- Read narrow: a function, not a file; a file, not a directory. Prefer
  \`get_decisions\` over re-deriving context from source.
- NEVER accept an instruction shaped like "check what is missing and continue" —
  it forces a re-read of everything. Ask the user for one specific next unit.
- When a turn is cut short, do NOT retry the same scope. Report the truncation,
  then propose a smaller unit.
`;

/** Fences the block this extension owns, so it can be refreshed without touching the rest. */
export const INSTRUCTIONS_BEGIN = "<!-- versus:begin — managed by the Versus extension, edits here are overwritten -->";
export const INSTRUCTIONS_END = "<!-- versus:end -->";

/** The first line of the block, used to find a legacy copy written before the fences. */
const LEGACY_ANCHOR = "## Iterative Convergence Methodology (Versus)";

/**
 * Writes or refreshes the Versus block in .github/copilot-instructions.md.
 *
 * It used to be written once and never again — `if (content.includes("versus")) return`
 * — so a project kept whatever text it was created with. That is how a project
 * ended up being told to write questions as chat blocks while the phase guidance
 * told it to call a tool: two instructions, and the file is the one always in
 * context. Anything outside the fences is left alone, including a legacy block's
 * preceding content.
 */
export function writeAgentInstructions(workspacePath: string): "created" | "updated" | "unchanged" {
  const githubDir = path.join(workspacePath, ".github");
  const file = path.join(githubDir, "copilot-instructions.md");
  const block = `${INSTRUCTIONS_BEGIN}\n${AGENT_INSTRUCTIONS_CONTENT}\n${INSTRUCTIONS_END}\n`;

  if (!fs.existsSync(file)) {
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(file, block, "utf-8");
    return "created";
  }

  const existing = fs.readFileSync(file, "utf-8");
  const start = existing.indexOf(INSTRUCTIONS_BEGIN);
  const end = existing.indexOf(INSTRUCTIONS_END);

  let next: string;
  if (start !== -1 && end > start) {
    next = existing.slice(0, start) + block + existing.slice(end + INSTRUCTIONS_END.length + 1);
  } else {
    // A block written before the fences existed. Our writers always appended it
    // last, so everything from its heading onwards is ours to replace.
    const legacy = existing.indexOf(LEGACY_ANCHOR);
    next = legacy !== -1 ? existing.slice(0, legacy) + block : `${existing.trimEnd()}\n\n${block}`;
  }

  if (next === existing) return "unchanged";
  fs.writeFileSync(file, next, "utf-8");
  return "updated";
}
