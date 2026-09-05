// MCP Tool: put a question to the user and wait for the answer.
//
// The methodology has always asked its questions as chat blocks, which stops the
// model only as far as the model chooses to stop. Against an agentic model that
// is not far: phases advanced with the questions answered by the model itself.
//
// Elicitation is the protocol's own answer. The server asks, the client renders a
// dialog, and the value comes back from the person — not from a generation. The
// model cannot supply it, cannot skip it, and cannot mistake its own reasoning
// for a decision that was made.

import { Tool } from "@modelcontextprotocol/sdk/types.js";

/** What the handler needs from the server, kept narrow so it can be faked in tests. */
export interface Elicitor {
  supportsElicitation(): boolean;
  elicit(params: {
    message: string;
    requestedSchema: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  }): Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>;
}

export const askUserTool: Tool = {
  name: "ask_user",
  description:
    "Puts a decision to the user and WAITS for their answer. Use it for every decision the " +
    "methodology says belongs to the user — never decide one yourself, and never write the " +
    "question as text and keep going.\n\n" +
    "The answer comes back from the user, so you cannot proceed without it. One question per " +
    "call. If it returns unavailable, ask in chat instead and stop your turn there.",
  inputSchema: {
    type: "object" as const,
    properties: {
      question: {
        type: "string",
        description: "The question, in one sentence. State what is being decided.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description:
          "The choices, recommended one first, each a short phrase with its rationale — " +
          "e.g. 'Complete product (recommended) — everything in one cycle'. " +
          "Omit for an open question.",
      },
      context: {
        type: "string",
        description: "Optional: why this is being asked now, and what the answer decides.",
      },
    },
    required: ["question"],
  },
};

/** The literal a caller can look for to tell "the user said no" from "the host cannot ask". */
export const ELICITATION_UNAVAILABLE = "elicitation-unavailable";

/** The way out of a closed list, offered as one of its entries rather than a second field. */
export const OTHER_OPTION = "Other — let me answer in my own words";

export async function handleAskUser(
  elicitor: Elicitor,
  args: { question?: string; options?: unknown; context?: string }
): Promise<string> {
  const question = String(args.question ?? "").trim();
  if (!question) {
    return JSON.stringify({ error: "A question is required." });
  }

  const options = Array.isArray(args.options)
    ? args.options.map((o) => String(o)).filter((o) => o.trim().length > 0)
    : [];

  if (!elicitor.supportsElicitation()) {
    // Said plainly rather than thrown: the model has a correct fallback — the R2
    // chat block — and an error would send it looking for a different tool.
    return JSON.stringify({
      status: ELICITATION_UNAVAILABLE,
      instruction:
        "This host cannot show a dialog. Ask the question in chat using the R2 block format, " +
        "then STOP your turn and wait. Do not answer it yourself and do not continue.",
      question,
      options,
    });
  }

  const message = [args.context?.trim(), question].filter(Boolean).join("\n\n");
  // ONE property, deliberately. The client renders a form property per step, so
  // a second field — a notes box, however optional — turns every question into a
  // two-page wizard the user has to click through. The escape from a closed list
  // is an entry IN the list instead, which costs a round trip only when taken.
  const answer =
    options.length > 0
      ? {
          type: "string" as const,
          title: "Your choice",
          description: `Pick one, or '${OTHER_OPTION}' to answer in your own words.`,
          enum: [...options, OTHER_OPTION],
        }
      : { type: "string" as const, title: "Your answer" };

  const result = await elicitor.elicit({
    message,
    requestedSchema: {
      type: "object",
      properties: { answer },
      required: ["answer"],
    },
  });

  if (result.action !== "accept") {
    return JSON.stringify({
      status: result.action,
      instruction:
        result.action === "decline"
          ? "The user declined to answer. Do not decide for them — ask what they would prefer, " +
            "or stop and let them direct the work."
          : "The user dismissed the dialog without answering. Ask again in chat, or stop and wait.",
      question,
    });
  }

  const content = result.content ?? {};
  const given = String(content.answer ?? "").trim();

  if (given === OTHER_OPTION) {
    return JSON.stringify({
      status: "open-answer-requested",
      question,
      instruction:
        "The user wants to answer in their own words. Call ask_user again with the same question " +
        "and NO options, so they get a free-text field. Do not guess what they meant.",
    });
  }

  return JSON.stringify({
    status: "answered",
    question,
    answer: given,
    nextStep:
      "Record it with record_decision so it survives this session, then act on it. The answer " +
      "came from the user — do not restate it as a question.",
  });
}
