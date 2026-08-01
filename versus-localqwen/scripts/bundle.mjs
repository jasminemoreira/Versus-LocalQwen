#!/usr/bin/env node

// Bundles the MCP server into a standalone file (no external dependencies).
// Output: out/bundle/server.js
//
// The sibling Versus extensions also bundle CLI hooks here. VS Code chat has no
// hook system, so this build has a single entry point — the safeguards those
// hooks carried live inside the MCP tool responses instead.

import { build } from "esbuild";
import { rmSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = resolve(root, "out", "bundle");

// Clean and recreate
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const entryPoints = [
  { in: resolve(root, "src", "mcp", "server.ts"), out: "server" },
];

try {
  await build({
    entryPoints: entryPoints.map((e) => ({ in: e.in, out: e.out })),
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    outdir: outDir,
    minify: false,        // readable for debug
    sourcemap: false,
    external: [],          // all inline, no external dependencies
  });

  console.log("Bundle completed in out/bundle/:");
  for (const e of entryPoints) {
    console.log(`  ${e.out}.js`);
  }
} catch (err) {
  console.error("Bundle error:", err);
  process.exit(1);
}
