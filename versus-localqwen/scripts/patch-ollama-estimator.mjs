#!/usr/bin/env node

// Stops the Ollama provider's token estimate from collapsing.
//
// The provider does not tokenize. It keeps a chars-per-token ratio and
// recalibrates after every response as `text.length / prompt_eval_count`, where
// text.length comes from partToText — which returns '' for tool calls, tool
// results and non-text parts, while prompt_eval_count covers the whole prompt.
// In an agent session most of the prompt is what the numerator drops, so each
// tool-heavy turn halves the distance to a much smaller ratio. Measured on
// qwen3.6: 4.00 at rest, ~1.8 after one turn, ~0.75 by the third. countTokens
// then prices text several times over and the host compacts with most of the
// window free.
//
// The patch clamps the ratio so it can never fall below the provider's own
// default. Upward calibration still works — a model that genuinely runs coarser
// than 4 chars/token will still be learned — but the downward collapse, which
// is an artifact of the mismatched numerator rather than a real measurement,
// cannot happen.
//
// This edits a third-party extension, so an Ollama update reverts it. Re-run.
// Reverting by hand: restore the .versus-backup file next to provider.js.
//
// Usage: node scripts/patch-ollama-estimator.mjs [--revert] [--extensions-dir DIR]

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const MARKER = "/* versus-localqwen: floor clamped */";

const ORIGINAL =
  "        this.charsPerToken.set(modelID, (currentCharsPerToken + observedCharsPerToken) / 2);";
const PATCHED =
  "        this.charsPerToken.set(modelID, Math.max(defaultCharsPerToken, " +
  `(currentCharsPerToken + observedCharsPerToken) / 2)); ${MARKER}`;

/** Every place VS Code keeps extensions, desktop and remote alike. */
function candidateRoots() {
  const home = homedir();
  return [
    join(home, ".vscode-server", "extensions"),
    join(home, ".vscode", "extensions"),
    join(home, ".vscode-server-insiders", "extensions"),
    join(home, ".vscode-insiders", "extensions"),
  ];
}

function findProviders(roots) {
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (!/^ollama\.ollama-/i.test(entry)) continue;
      const provider = join(root, entry, "out", "provider.js");
      if (existsSync(provider)) found.push(provider);
    }
  }
  return found;
}

function apply(file, revert) {
  const backup = `${file}.versus-backup`;
  const source = readFileSync(file, "utf-8");

  if (revert) {
    if (!existsSync(backup)) {
      console.log(`  skip   ${file}\n         no backup to restore`);
      return false;
    }
    copyFileSync(backup, file);
    console.log(`  revert ${file}`);
    return true;
  }

  if (source.includes(MARKER)) {
    console.log(`  ok     ${file}\n         already patched`);
    return false;
  }

  if (!source.includes(ORIGINAL)) {
    console.log(
      `  FAIL   ${file}\n` +
        "         the calibration line was not found — the provider changed shape.\n" +
        "         Inspect CalibratedTokenEstimator.record() before patching by hand."
    );
    return false;
  }

  if (!existsSync(backup)) {
    copyFileSync(file, backup);
  }
  writeFileSync(file, source.replace(ORIGINAL, PATCHED), "utf-8");
  console.log(`  patch  ${file}\n         backup at ${backup}`);
  return true;
}

const args = process.argv.slice(2);
const revert = args.includes("--revert");
const dirIndex = args.indexOf("--extensions-dir");
const roots = dirIndex !== -1 && args[dirIndex + 1] ? [args[dirIndex + 1]] : candidateRoots();

const providers = findProviders(roots);
if (providers.length === 0) {
  console.error("No Ollama extension found. Searched:\n  " + roots.join("\n  "));
  process.exit(1);
}

console.log(revert ? "Reverting:" : "Patching:");
let changed = 0;
for (const provider of providers) {
  if (apply(provider, revert)) changed += 1;
}

if (changed > 0) {
  console.log(
    "\nRestart the extension host for this to take effect:\n" +
      "  Ctrl+Shift+P -> Developer: Restart Extension Host"
  );
}
