// Pins PARAMETER num_ctx on a model so the chat host budgets prompts against
// the window the server will actually honour.
//
// The Ollama VS Code provider resolves the window in this order (its
// sharedContextWindow): show.parameters.num_ctx → PARAMETER num_ctx in the
// modelfile → any model_info key ending in .context_length → 32768. Models that
// pin nothing therefore advertise their architectural maximum, which can be
// several times the runtime window. Writing num_ctx wins the precedence and
// closes the gap.

import { spawn } from "child_process";

export interface AlignResult {
  ok: boolean;
  model: string;
  numCtx: number;
  message: string;
}

function run(
  command: string,
  args: string[],
  stdin?: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

/** Inserts or replaces `PARAMETER num_ctx` in a modelfile, preserving everything else. */
export function withNumCtx(modelfile: string, numCtx: number): string {
  const lines = modelfile.split("\n");
  const out: string[] = [];
  let replaced = false;

  for (const line of lines) {
    if (/^\s*PARAMETER\s+num_ctx\s+/i.test(line)) {
      if (!replaced) {
        out.push(`PARAMETER num_ctx ${numCtx}`);
        replaced = true;
      }
      continue; // drop duplicates
    }
    out.push(line);
  }

  if (replaced) return out.join("\n");

  // No existing num_ctx — insert after the last PARAMETER, or after FROM.
  const anchor = out.reduce(
    (best, line, i) =>
      /^\s*PARAMETER\s+/i.test(line) || /^\s*FROM\s+/i.test(line) ? i : best,
    -1
  );
  if (anchor === -1) {
    throw new Error("Modelfile has neither a FROM nor a PARAMETER line to anchor to.");
  }
  out.splice(anchor + 1, 0, `PARAMETER num_ctx ${numCtx}`);
  return out.join("\n");
}

/**
 * Rewrites the model tag with num_ctx pinned. The weights blob is referenced by
 * digest in the modelfile, so nothing is re-downloaded and only the manifest
 * changes. Reversible by rebuilding from the returned original.
 */
export async function alignModelContext(
  model: string,
  numCtx: number
): Promise<AlignResult & { originalModelfile?: string }> {
  const show = await run("ollama", ["show", "--modelfile", model]);
  if (show.code !== 0) {
    return {
      ok: false,
      model,
      numCtx,
      message: `Could not read the modelfile for ${model}. Is the ollama CLI on PATH? ${show.stderr.trim()}`,
    };
  }

  const original = show.stdout;
  if (!original.includes("FROM ")) {
    return { ok: false, model, numCtx, message: `Unexpected modelfile for ${model}.` };
  }

  let patched: string;
  try {
    patched = withNumCtx(original, numCtx);
  } catch (err) {
    return { ok: false, model, numCtx, message: String(err) };
  }

  const create = await run("ollama", ["create", model, "-f", "-"], patched);
  if (create.code !== 0) {
    return {
      ok: false,
      model,
      numCtx,
      message: `ollama create failed: ${create.stderr.trim() || create.stdout.trim()}`,
      originalModelfile: original,
    };
  }

  return {
    ok: true,
    model,
    numCtx,
    message: `${model} now pins num_ctx ${numCtx}. Reload the window so the chat host re-reads the model's limits.`,
    originalModelfile: original,
  };
}
