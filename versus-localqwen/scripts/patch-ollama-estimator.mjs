#!/usr/bin/env node

// Command-line front end for the Ollama estimator clamp.
//
// The extension applies this on activation, so running it by hand is only
// needed when auto-patching is off or when you want the result before the next
// extension host start. Either way the logic lives in src/ollama/estimator-patch.ts
// — one implementation, so the script and the extension cannot drift apart.
//
// Usage: node scripts/patch-ollama-estimator.mjs [--revert] [--extensions-dir DIR]

import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compiled = join(root, "out", "ollama", "estimator-patch.js");

if (!existsSync(compiled)) {
  console.error(
    "Build output missing. Run `npm run compile` first — this script is a front end " +
      "for src/ollama/estimator-patch.ts rather than a second copy of it."
  );
  process.exit(1);
}

const { applyPatch, findProviders, inspect, revertPatch } = await import(compiled);

function candidateRoots() {
  const home = homedir();
  return [
    join(home, ".vscode-server", "extensions"),
    join(home, ".vscode", "extensions"),
    join(home, ".vscode-server-insiders", "extensions"),
    join(home, ".vscode-insiders", "extensions"),
  ];
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

console.log(revert ? "Reverting:" : "Clamping:");
let changed = 0;
for (const provider of providers) {
  const before = inspect(provider);
  const result = revert ? revertPatch(provider) : applyPatch(provider);
  const verb = result.changed ? (revert ? "revert" : "patch") : before === "patched" ? "ok" : "skip";
  console.log(`  ${verb.padEnd(6)} ${provider}\n         ${result.message}`);
  if (result.changed) changed += 1;
}

if (changed > 0) {
  console.log(
    "\nRestart the extension host for this to take effect — the running one still holds\n" +
      "the previous copy:\n  Ctrl+Shift+P -> Developer: Restart Extension Host"
  );
  if (revert) {
    console.log(
      "\nThe extension reapplies the clamp on activation. To keep it off, set\n" +
        "  versus-localqwen.autoPatchOllamaEstimator: false"
    );
  }
}
