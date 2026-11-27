# Versus for Local Qwen

**IACDM (Interactive Adversarial Convergence Development Methodology) orchestrator for local models served by Ollama in VS Code Agent Mode.**

An original methodology created by [Jasmine Moreira](https://github.com/jasminemoreira) that transforms LLMs from reactive code generators into disciplined agents following a structured 8-phase process — from problem discovery to delivery with tests and post-review.

> The methodology is identical to its sibling builds. What differs is the operating regime: a 27B model on one consumer GPU, where the context window is the binding constraint and overflow is silent.

## The Problem: the Verification Gap

In 2025, AI-assisted development reached critical mass. Platforms like Lovable, Cursor, Claude Code, and ChatGPT allow anyone to generate complete applications from natural language. The phenomenon — dubbed *vibe coding* by Andrej Karpathy — transformed the perception of who can build software and how fast.

The empirical data tells a different story:

- **METR study (2025):** in a randomized controlled trial, 16 experienced developers using Cursor Pro with Claude 3.5/3.7 Sonnet predicted AI would make them 24% faster and afterwards believed they had been 20% faster. Measured: they were **19% slower** — a 39-point gap between perception and reality. (Other trials report gains; the paper discusses why they disagree.)
- **CVE-2025-48757 (Lovable):** 10.3% of 1,645 showcase apps (170) exposed sensitive data through misconfigured or absent Row Level Security — 303 endpoints leaking names, emails, payment data, and API keys.
- **Stack Overflow 2025:** the first significant decline in positive sentiment toward AI tools (from over 70% to 60%), even as adoption rose to 84%; only 3% of developers report high trust in AI output accuracy.

**The critical observation:** these problems aren't tool-specific. Lovable uses Claude. Claude Code uses Claude. ChatGPT uses GPT. Cursor uses both. All operate as stochastic generators: `P(token_n | context)`. None of them verify what they produce internally: absent external tool use, semantic verification capability is **zero** in all cases.

The real distinction isn't between tools. It's between two modes of operation:

| Without methodology | With Iterative Convergence |
|---|---|
| `prompt → GA → artifact → delivery` | `design → G₀ → critique → G₁ → ... → Gₙ → delivery` |
| Verification gap open | Discrete gates with VA-automatic and VA-human |
| Errors detected at `t = production` | Errors detected at `t = gate_k` (earliest possible phase) |
| Perception: +20% / Reality: −19% (METR) | Measurable at each gate (concrete feedback) |

**Iterative Convergence was born from this observation:** the quality of AI-assisted software is determined by the process, not the tool.

## Three Core Theses

1. **The quality of AI-assisted software is determined by the quality of the design that precedes code generation**, not by the generative capability of the model.
2. **AI is most productive when operating on granular work units** with explicit scope, documented assumptions, and well-defined interfaces — maximizing the useful-information/context-consumed ratio.
3. **Deep understanding of the problem is a precondition for any technical decision.** Understanding the wrong problem is orders of magnitude more expensive than understanding it slowly.

## The GA/VA Model: External Verification

An LLM (the **Generative Agent**, GA) has no internal function `V(artifact) → {correct, incorrect}`. This is the **verification gap**: the space between what is generated and what is verifiable by the generator itself.

The methodology closes this gap by instituting **external Verification Agents** (VA) at discrete **gates**:

```
P₀ → G₀ → P₁ → G₁ → ... → Pₙ → Gₙ → delivery
      ↑              ↑                    ↑
  VA evaluates   VA evaluates        VA evaluates
  (rejects →     (rejects →          (rejects →
   feedback)      feedback)           feedback)
```

- **VA-automatic:** tests, linters, compilers, type checkers — binary verdict on specific properties.
- **VA-human:** the operator — evaluates semantic adequacy, usability, domain correctness, and properties that escape automatic verification.

**The gate is enforced, not conventional.** Phase advancement is a function that can fail: a state machine external to the model refuses the transition while any exit criterion is unmet or any applicable safeguard is violated. The agent may request advancement; it cannot grant it. Some criteria cannot be satisfied by assertion at all — the architecture, the coverage matrix, and the post-review lessons must exist as files under `specs/`, and *tests passing* is recorded only by the hook that observes the test run.

**Key properties:**
- *Generative invariance:* the methodology doesn't improve the model. It improves the process.
- *Observability:* each gate makes artifact properties observable that would be invisible without external verification.
- *Temporal error localization:* errors are detected at `t = gate_k`, always before delivery.
- *Reconditioning quality:* when a VA rejects an artifact, the feedback constitutes concrete information that conditions the next generation — intuitively superior to the original prompt, though not yet empirically measured.

## The 8 Phases

| # | Phase | Purpose | Principal artifact |
|---|---|---|---|
| 0 | Problem Discovery | Understand domain and problem before any technical solution | Validated document (score ≥90/100) + specs/ populated |
| 1 | Architecture | Define modules, interfaces, and technical contracts | Architecture V1 (~2k tokens) |
| 2 | Adversarial Critique | Attack architecture with up to 19 specialized lenses (7 universal + up to 12 conditional) | Coverage matrix (modules × lenses) |
| 3 | Simplification | Simplify without introducing bugs; generate V(N+1) | Simplified architecture |
| 4 | Convergence Gate | Validate convergence with rigorous criteria | Final approved architecture |
| 5 | Code Implementation | Implement without regression; one module at a time | Functional code |
| 6 | Tests | Test against interfaces; mandatory manual testing | 100% tests passing |
| 7 | Post-Review | Systematic learning; methodology evolution | Lessons + method improvement proposal |

Phases 2-3 form an iterative loop that repeats until convergence. **The stopping criterion belongs to the operator:** structural change below 15% between consecutive versions, zero critical findings, and every important finding resolved or explicitly deferred with rationale. In the paper's validation batch (12 projects of 8–12 modules) the loop ran 2–4 times per project. Phase 7 implements **double-loop learning** (Argyris, 1977): evaluating both the product and the process itself. After Phase 7, the methodology offers **meta-iteration** (v1.0 → v2.0): reset to Phase 0 while preserving all decisions, specs/, and project context as baseline for the next cycle.

## Phase 0: Hierarchical Semantic Analysis (HSA)

Phase 0 is the most distinctive contribution. It formalizes an observation: **understanding the wrong problem is orders of magnitude more expensive than understanding it slowly** (consistent with Boehm's cost-of-change curves).

Each iteration of Phase 0 runs four steps — *collection* (structured questions), *teach-back* (the AI restates the problem in domain language), *confrontation* (the operator corrects it), and *convergence assessment* (a 0–100 score over 10 weighted criteria). The teach-back inverts the direction of agreement bias: instead of the AI confirming it understood, the human judges whether the AI's explanation matches the intended problem. The gate requires a score ≥ 90 **and** explicit operator confirmation — 90 is sufficient; do not aim for 100.

The HSA structures exploration in five levels, each building on the previous:

| Level | Focus | What is sought |
|---|---|---|
| 1. Domain | The universe where the problem exists | Vocabulary, theoretical field, technical field, methodologies, tools, state of the art |
| 2. Problem | What needs to be solved | 5W1H: who, what, when, where, why, how is it solved today |
| 3. Elements | The parts that compose the problem | Components, entities, resources, actors, constraints |
| 4. Processes | How the parts relate | Flows, transformations, dependencies, events, feedback cycles |
| 5. Product | What is expected at the end | Deliverables, acceptance criteria, result format, success metrics |

The hierarchy enforces **epistemic order** (understand the domain before decomposing the problem), **structure-dynamics separation** (elements vs. processes as orthogonal dimensions), and **early shared vocabulary** (terminological ambiguities resolved at the cheapest possible level).

## Adversarial Critique with Specialized Lenses

Phase 2 applies up to 19 specialized lenses, each with its own central question, in three categories. The principle: **a lens is legitimate only if removing it exposes a class of failure that no other lens detects.**

**Universal lenses (7 — always applied):**

| Universal lens | Central question |
|---|---|
| Assumptions | What does this design assume as truth without declaring it? |
| Architectural | Can each module be replaced, removed, or tested in isolation? |
| Implementability | Can I code this module in one session with available context? |
| Scientific | Does every value, formula, and algorithm have a verifiable reference? |
| Security | How would an attacker exploit this surface with minimal effort? |
| Performance | Where are the bottlenecks and what is the asymptotic behavior? |
| Regulatory | Does every normative requirement have traceability to a module? |

**Situational lenses (8 — activated by project context):** Resilience, UI/UX, Migration / Coexistence, Sustainability / Proportionality, Ethical / Human Impact, Process / Workflow, Governance / Accountability, Observability / Operability.

**Domain Transfer lenses (4 — activated by signal detection):** Control Engineering, Game Theory, Linguistics / Grammar, Mechanical Engineering. They import invariants from domains outside software engineering to expose failure classes that software vocabulary cannot name.

Every conditional lens is declared active or inactive with an explicit rationale — a non-activated lens is a documented decision, not a silent omission.

**Validated:** in a pre-registered experiment over twelve projects, every one of the 19 lenses found at least one defect no other lens found; mean overlap across lenses was 11% ([data](https://doi.org/10.5281/zenodo.21908908)). The same experiment found that the *criterion deciding when to apply* a conditional lens is the weak part, and three triggers were rewritten.

**Critical asymmetry:** multiple agents to attack, unified agent to respond, human operator to arbitrate trade-offs. The **coverage matrix** (modules × lenses) supports concentration analysis — a module drawing findings from most lenses is more likely conceptually flawed than locally deficient (redesign, not patches); a lens drawing findings across most modules points to a systemic cause. These readings are heuristics, not thresholds.

## Context Efficiency and Granularization

The operational constraint of current LLMs isn't generation capacity — it's the finite context window. The methodology maximizes:

```
E = I₀ / C
```

Where `E` = context efficiency, `I₀` = relevant information, `C` = total context consumed. In a monolithic system, `E` tends to zero as the system grows. In a granularized system with explicit interfaces, `E` stays high because each interaction provides only the interface signature (compact) and the current module code (relevant).

**The decoupled session cycle:**
- **Design Session** (Phases 0-4): context = domain + constraints → architecture + interfaces
- **Code Session** (Phase 5): context = architecture + module interface → 100% dedicated
- **Test Session** (Phase 6): context = interface + contract → no internal code needed
- **Validation Session:** CI/CD runs tests → AI only invoked for corrections

## The Knowledge Repository (specs/)

The `specs/` directory functions as a persistent external memory that accumulates knowledge across sessions and phases. It addresses both the AI's finite context window and the operator's finite working memory.

Three key properties:
- **Traceability:** every technical decision has a trail in specs/. The rule "never implement an algorithm without a bibliographic reference" prevents code generation based on statistical plausibility.
- **Inter-session persistence:** the operator returning after weeks finds accumulated context. The AI consults specs/ before asking questions.
- **Inter-version transferability:** if the project evolves to v2.0, Phase 0 starts from v1.0's specs/ as baseline. Knowledge is never lost between cycles.

## Anti-Patterns

| # | Anti-pattern | Description |
|---|---|---|
| AP1 | Validation theater | Asking the AI "is this design good?" and accepting the affirmative. Antidote: never ask for validation; ask for refutation. |
| AP2 | Complexity inflation | Adding components when critique reveals fragility. Each iteration must maintain or reduce complexity. |
| AP3 | Monolithic session | Design, code, and tests in a single conversation. Context saturates. One session per phase, one phase per module. |
| AP4 | Implicit assumption | The design works — as long as conditions nobody listed are true. |
| AP5 | VA-human absence | Trusting exclusively in automated tests. Semantic adequacy requires human judgment. |
| AP6 | Phase 0 bypass | Starting with architecture without understanding the problem. Cost: orders of magnitude relative to early discovery. |
| AP7 | Reference-free implementation | Implementing domain algorithms without a bibliographic reference — plausible code with invented parameters. |
| AP8 | Convergence perfectionism | Infinite cycles seeking a "perfect" design. The stopping criterion is the G₄ gate: < 15% structural change, zero criticals, importants resolved or deferred. |
| AP9 | Silent scope creep | Adding features during Phases 2-3 without operator approval. The AI may suggest; never decide. |
| AP10 | Verified-solution bypass | Generating plausible code for a problem that already has an established solution. Antidote: tier assessment per module. |
| AP11 | Implementation drift | Silent divergence between code and `specs/`. Antidote: after each module, ask "where does this implementation diverge from specs/?" — not "is this correct?". |
| AP12 | Scope presence blindness | Passing tests does not prove every module was built. Antidote: a scope inventory before leaving Phase 5. |

## Relation to Existing Methods

| Tradition / Method | Incorporated principle | Adaptation |
|---|---|---|
| Spiral Model (Boehm, 1986) | Iterative cycles with risk analysis | Risk evaluated is design fragility; AI is risk analysis partner |
| Design by Contract (Meyer, 1992) | Pre/post-conditions and invariants | Explicit assumptions and negative scope function as informal contracts |
| Falsificationism (Popper, 1959) | Knowledge advances by refutation | Adversarial critique seeks to refute the design, not validate it |
| Red Teaming (NSA/DARPA) | Dedicated team attacking the system | AI assumes red team role under adversarial prompt |
| Perspective-Based Reading (Basili et al., 1996) | Reviewers read one document from assigned perspectives | Lenses apply the same idea to a single generator rather than to distinct reviewers |
| ATAM (Kazman et al., 2000) | Scenario-based architectural trade-offs | Each critique cycle evaluates trade-offs and forces explicit decisions |
| KISS / YAGNI (XP, Beck 1999) | Simplicity as value | Each iteration must simplify, not complexify |
| TDD (Beck, 2003) | Tests drive design | Adversarial critique functions as "design test" before code |
| ADR (Nygard, 2011) | Decision documentation with context | Documented assumptions and limitations serve equivalent role |

## The Local Regime

Everything above holds for any model. What follows exists because a local model on
consumer hardware fails in ways an API-served frontier model does not, and those
failures are invisible from inside the conversation.

**Overflow does not raise.** Models in the `qwen35` family interleave full attention
with linear/SSM layers — `full_attention_interval = 4` means one layer in four keeps a
conventional KV cache. Linear-layer state cannot be partially evicted, so llama.cpp
disables context shifting. There is no sliding window and no graceful degradation:
when the prompt fills `n_ctx` it is **clipped**, and the runner starts with `--keep 4`,
so what survives is the first four tokens rather than the tool definitions. Generation
then stops mid-emission. No error, no exception, no stop reason the host surfaces —
the visible symptom is a turn ending in *"I'll create the files now!"* with no tool
call, which reads as the model losing the thread.

**The host and the server can disagree about the window.** The Ollama VS Code provider
resolves the context size from the model's *architectural* maximum when no `num_ctx` is
pinned. For `qwen3.6:27b` that is 262144, so VS Code advertises 258048 input tokens to
a server running 65536 — prompts built against a budget four times too large, clipped
on arrival.

**The host's token count drifts.** The provider does not tokenize; it keeps a
chars-per-token ratio and recalibrates it against text that excludes tool calls and
tool results, while the denominator counts the whole prompt. In a tool-heavy session
the ratio collapses. Measured on qwen3.6: a 61440-token budget behaving like 17220.

The extension answers each of these with a measurement rather than a heuristic —
`check_context_budget`, a context-health status bar, **Align Model Context Window**,
and a patch script for the provider's estimator. The mechanics, the VRAM table per
window size, and the numbers behind every claim are in
**[versus-localqwen/README.md](versus-localqwen/README.md)**.

## LLM Compatibility

The methodology demands strict instruction following, reliable MCP tool calling, and
sustained reasoning across long contexts. On a local model the third requirement is
the one that binds.

### Selection Criteria

| Criterion | Why it matters |
|---|---|
| Instruction following | Each phase carries 700–3400 tokens of behavioral rules. Models that summarize or skip steps break the methodology |
| MCP tool reliability | 17 tools must be called consistently. A model that narrates tool calls instead of executing them is incompatible at any size |
| Context window | Phases 0-2 accumulate quickly. 32k is the floor and it is genuinely tight; 64k is the working point |
| Reasoning depth | Phases 0-4 are architectural analysis, not code generation. Shallow reasoning produces shallow designs |

Verify tool support before committing to a model: `ollama show <model>` must list
`tools` under capabilities.

### Where a local model actually fits

| Phase range | Fit | Why |
|---|---|---|
| 2 — Adversarial Critique | **Strong** | One unit at a time. A function is hundreds of tokens, so the window is never the constraint and the model works in its best regime |
| 5-7 — Code, tests, review | **Good** | The architecture is settled and persisted; the work is bounded and locally verifiable |
| 0-1 — Discovery, architecture | **Demanding** | Ambiguous, open-ended, and the phase where accumulated context is largest |

Phase 2 is where a local model earns its keep. If critique holds up while agent mode
strains, that is evidence for the granular design rather than a limitation of it.

### The LLM Switch Point, inverted

The methodology has a natural switch at Phase 4: the architecture is validated and
persisted in `state.json` + `specs/`, so nothing is lost by changing models. The usual
strategy runs a capable model through design and a cheaper one through implementation.

Running locally inverts the economics. Tokens cost electricity, not money, so the
pressure is not toward a cheaper model for Phases 5-7 — it is toward a *more capable*
one for Phases 0-4, where a local model is weakest and an architectural error is most
expensive to discover later.

| Strategy | Phases 0-4 | Phases 5-7 | Best for |
|---|---|---|---|
| Hybrid | A frontier model | Local | Most projects — buy reasoning where it pays, run the bulk for free |
| Fully local | Local | Local | Offline work, sensitive code, or measuring what a local model can carry |
| Critique-only | Any | Any | Keep the main agent elsewhere and use the local model as the adversarial pole in Phase 2 |

Both switch points — forward at P4→P5 and reverse at Phase 7 → new cycle — are asked
as decisions, not announced as notices. The choice is only free before the work begins.

### Built-in Protections

The sibling builds enforce several safeguards with CLI hooks. VS Code chat has no hook
system, so those move into the MCP layer, and the difference is worth stating plainly:
a hook observes regardless of cooperation, while a tool depends on the model calling it.

| Mechanism | Protects against | Enforcement |
|---|---|---|
| Gateway Guard | Acting without loading context | Tool response — appended to every non-exempt call |
| Phase transition gate | Advancing with criteria unmet or a safeguard violated | Hard — `advance_phase` refuses and names the reason |
| S6 loop detection | Blind debugging: re-running tests with no named cause | Mixed — `record_test_outcome` feeds it, but a violated S6 vetoes the transition |
| Approval records | Crossing 3→4, 4→5, 6→7 or closing the cycle with no human sign-off on record | Hard — refused without a `record_decision(category='approval', approvedBy=…)` of the current pass of the phase (presence, not truth) |
| Shape gates (5→6, 6→7) | Scope Inventory shown but never recorded; promised `T-xx` tests that do not exist; design drift left out of the architecture | Hard — `advance_phase` names what is missing |
| Declared checks | A mechanically checkable criterion attested instead of run | Mixed — the model reports the run through `record_check_outcome`; the engine compares it with the declared expectation |
| Cycle archive | A closed cycle's criteria and provenance vanishing at the next one | `start_new_cycle` archives it; `.versus/cycles/cycle-N.md` is the readable record (`export_cycle` for any cycle) |
| `check_context_budget` | Starting a turn that cannot fit | Advisory — the model must call it before long work |
| Context health status bar | Silent window loss | Out-of-band — reported from outside the conversation |
| Phase 7 engine hint | Skipping the meta-iteration offer | Tool response |

## Requirements

- **VS Code** >= 1.120.0 — chat and agent mode ship in core, so no Copilot subscription is involved
- **Node.js** >= 18.0.0 (runs the MCP server)
- **[Ollama for VS Code](https://marketplace.visualstudio.com/items?itemName=Ollama.ollama)** — publisher `Ollama`, blue verified badge. Several unverified extensions share the llama icon; this is the one registering the `ollama-models` provider
- **Ollama** with a model that reports the `tools` capability

## Installation

### From VS Code Marketplace
Search for **"Versus for Local Qwen"** in Extensions, or:
```
ext install jasminemoreira.versus-localqwen
```

### From Source
```bash
cd versus-localqwen
npm install && npm run build
npx @vscode/vsce package --no-dependencies
code --install-extension versus-localqwen-*.vsix
```

## Quick Start

1. Add your model to the chat picker: `Ctrl+Shift+P` → **Chat: Manage Language Models** → **Add Models** → **Ollama**. You may need **Unhide** before it is selectable
2. Run **Versus LocalQwen: Check Context Budget**. Fix anything it flags before starting — a misaligned window will cost you a session
3. `Ctrl+Shift+P` → **Versus LocalQwen: Initialize Project**
4. Open a **new chat session** (`Ctrl+Alt+I`) — MCP servers and instruction files are only picked up when a session starts
5. Type **`start`**

> Typing `retomar Versus` at any point reloads phase, decisions and instructions.

> **VS Code on Windows, Ollama in WSL?** The server binds to `127.0.0.1` inside the VM and is invisible from the host. Point `versus-localqwen.ollamaUrl` at the VM IP, or reopen the folder in a WSL remote window.

## Companion Extensions

**[Versus for Claude](https://github.com/jasminemoreira/Versus-Claude)**,
**[Versus for Cursor](https://github.com/jasminemoreira/Versus_Cursor)**,
**[Versus for Qwen](https://github.com/jasminemoreira/Versus-Qwen)** and
**[Versus for Kimi](https://github.com/jasminemoreira/Versus-Kimi)** cover the other
agents. All builds share the `.versus/state.json` format and keep their binaries in
separate subfolders, so they install side by side and a project can move between them
mid-methodology — including handing design to a frontier model and implementation to
the local one.

## License

[MIT](versus-localqwen/LICENSE)

---

*Created by [Jasmine Moreira](https://github.com/jasminemoreira). Developed and validated on the Goitacaz project (2025-2026).*

> *"A converged design is not a finished design, but one that is certainly ready to evolve."*
