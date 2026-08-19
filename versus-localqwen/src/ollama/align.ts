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
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface AlignResult {
  ok: boolean;
  model: string;
  numCtx: number;
  message: string;
}

function run(
  command: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end();
  });
}

/**
 * The modelfile that pins `num_ctx` on an existing tag.
 *
 * It derives FROM the tag rather than patching the output of
 * `ollama show --modelfile`, for two reasons. That output names the weight blobs
 * by absolute path, and building from it makes Ollama re-import ~17 GB — minutes
 * of work to change one number. And deriving inherits the tag's whole
 * configuration, so the template, renderer, parser, license and every parameter
 * the user set by hand are preserved by Ollama itself instead of by our
 * line-editing. A later PARAMETER overrides an inherited one, so re-pinning a tag
 * that already had a num_ctx replaces it.
 */
export function alignmentModelfile(model: string, numCtx: number): string {
  return `FROM ${model}\nPARAMETER num_ctx ${numCtx}\n`;
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

  // Through a file, never stdin: `ollama create -f -` stopped reading standard
  // input (0.32.14 answers "no Modelfile or safetensors files found"), and the
  // failure is silent from the caller's side beyond a non-zero exit.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "versus-align-"));
  const modelfilePath = path.join(dir, "Modelfile");
  let create: { code: number; stdout: string; stderr: string };
  try {
    fs.writeFileSync(modelfilePath, alignmentModelfile(model, numCtx), "utf-8");
    create = await run("ollama", ["create", model, "-f", modelfilePath]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

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
