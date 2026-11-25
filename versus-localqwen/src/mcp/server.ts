#!/usr/bin/env node

// MCP Server — standalone process (stdio)
// Started by the VSCode extension or manually via `node server.js --workspace <path>`
// Supports Claude Code and VS Code Agent Mode

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import { StateEngine } from "../state/engine";
import { ALL_TOOLS, handleToolCall } from "./tools/index";
import { Elicitor } from "./tools/ask-tools";

function getWorkspacePath(): string {
  // Priority: --workspace arg > CLAUDE_PROJECT_DIR env > VERSUS_WORKSPACE env > cwd
  const args = process.argv.slice(2);
  const wsIndex = args.indexOf("--workspace");
  if (wsIndex !== -1 && args[wsIndex + 1]) {
    return args[wsIndex + 1];
  }
  if (process.env.CLAUDE_PROJECT_DIR) {
    return process.env.CLAUDE_PROJECT_DIR;
  }
  if (process.env.VERSUS_WORKSPACE) {
    return process.env.VERSUS_WORKSPACE;
  }
  return process.cwd();
}

async function main() {
  const workspacePath = getWorkspacePath();
  const engine = new StateEngine(workspacePath);
  engine.load();

  const server = new Server(
    {
      name: "versus-localqwen",
      version: "0.14.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  /**
   * Asking the user through the protocol instead of through the model.
   *
   * The capability is negotiated at initialize, so it can only be read after the
   * client has connected — hence a function rather than a value. Where the client
   * does not offer it, `ask_user` says so and the model falls back to the chat
   * block, which is what every host had before this existed.
   */
  const elicitor: Elicitor = {
    supportsElicitation: () => server.getClientCapabilities()?.elicitation !== undefined,
    // Cast at the adapter: the tool describes its form with a plain object so it
    // stays testable without the SDK, and the client validates the schema anyway.
    elicit: (params) =>
      server.elicitInput({ ...params, mode: "form" } as Parameters<typeof server.elicitInput>[0]),
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: ALL_TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      // Re-read before every call. The state file is written by other
      // processes — the extension host on init, and this server's own earlier
      // instances in another window — and the engine saves after each mutation,
      // so disk is authoritative. Without this the evidence gates would judge a
      // snapshot taken at startup.
      engine.load();
      const result = await handleToolCall(
        name,
        (args ?? {}) as Record<string, unknown>,
        engine,
        elicitor
      );
      return {
        content: [{ type: "text" as const, text: result }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: `Internal error: ${String(err)}` }),
          },
        ],
        isError: true,
      };
    }
  });

  /**
   * What the client offered, on stderr so it lands in the MCP output channel.
   *
   * Whether questions reach a person through a dialog or through a chat block is
   * decided entirely by a capability negotiated here, and there was no way to see
   * which had happened — the symptom (a question written as prose) looks the same
   * as a model ignoring its instructions. One line ends that guessing.
   */
  server.oninitialized = () => {
    const caps = server.getClientCapabilities() ?? {};
    const info = server.getClientVersion();
    const offered = Object.keys(caps).sort().join(", ") || "(none)";
    console.error(
      `[versus] client ${info?.name ?? "unknown"} ${info?.version ?? ""} offers: ${offered}`
    );
    const verdict = caps.elicitation
      ? "elicitation available — ask_user will open a dialog the model cannot answer"
      : "elicitation NOT offered by this client — ask_user falls back to a chat block, " +
        "which stops the model only if it chooses to stop";
    console.error(`[versus] ${verdict}`);

    // Also to disk. The stderr goes to an output channel that takes three steps
    // to find, and the question it answers — dialog or chat block — comes up
    // every time a question arrives as prose. One line, overwritten each start,
    // inside the directory this project already owns.
    try {
      fs.writeFileSync(
        path.join(workspacePath, ".versus", "mcp-client.log"),
        `${new Date().toISOString()} ${info?.name ?? "unknown"} ${info?.version ?? ""}\n` +
          `offers: ${offered}\n${verdict}\n`,
        "utf-8"
      );
    } catch {
      /* diagnostics never block the server */
    }
  };

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Versus MCP Server fatal: ${String(err)}\n`);
  process.exit(1);
});
