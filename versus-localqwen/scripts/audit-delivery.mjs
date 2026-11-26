#!/usr/bin/env node
// Delivery audit for the VS Code chat host: what each Versus tool EMITTED vs what REACHED
// the model. Run after every VS Code / Copilot Chat update and before every release.
//
//   node scripts/audit-delivery.mjs <project dir> [--since YYYY-MM-DD] [--storage <workspaceStorage dir>]
//
// Ground truth on this host (measured for 0.15.0):
//   - Chat sessions live in the WINDOWS user's workspaceStorage/<hash>/chatSessions/*.jsonl
//     (VS Code runs on Windows, the extension host in WSL). <hash>/workspace.json names the folder.
//   - `metadata.toolCallRounds[].toolCalls[]` gives each call's id and tool name;
//     `metadata.toolCallResults[<id>].content[].value` is the text the tool returned.
//   - When the host moves a result out of the prompt, it writes it to the WSL side at
//     ~/.vscode-server/data/User/workspaceStorage/<hash>/GitHub.copilot-chat/
//     chat-session-resources/<sessionId>/<callId>__vscode-…/content.txt and the model gets a
//     pointer instead. A call with such a directory was NOT delivered inline.
//   - Resource directories are cleaned up over time: a session with no resource directory at
//     all is reported as "unknown", not as "all inline".
//
// Versus is a pass only when no Versus tool call was externalized.

import fs from "fs";
import os from "os";
import path from "path";

const args = process.argv.slice(2);
const project = args.find((a) => !a.startsWith("--"));
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
if (!project) {
  console.error("usage: node scripts/audit-delivery.mjs <project dir> [--since YYYY-MM-DD] [--storage <dir>]");
  process.exit(2);
}
const since = opt("--since") ? Date.parse(opt("--since")) : 0;

function windowsStorages() {
  if (opt("--storage")) return [opt("--storage")];
  const users = "/mnt/c/Users";
  if (!fs.existsSync(users)) return [];
  return fs.readdirSync(users)
    .map((u) => path.join(users, u, "AppData", "Roaming", "Code", "User", "workspaceStorage"))
    .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

const want = path.resolve(project);
const hashes = [];
for (const root of windowsStorages()) {
  for (const h of fs.readdirSync(root)) {
    const wj = path.join(root, h, "workspace.json");
    if (!fs.existsSync(wj)) continue;
    try {
      const folder = decodeURIComponent(JSON.parse(fs.readFileSync(wj, "utf-8")).folder ?? "");
      const p = folder.replace(/^vscode-remote:\/\/[^/]+/, "").replace(/^file:\/\//, "");
      if (path.resolve(p) === want) hashes.push({ root, hash: h });
    } catch { /* skip */ }
  }
}
if (!hashes.length) {
  console.error(`No VS Code workspace storage found for ${want}.`);
  process.exit(1);
}

const wslRes = path.join(os.homedir(), ".vscode-server", "data", "User", "workspaceStorage");
const perTool = new Map();
let anyExternalized = false;
let unknownSessions = 0;

for (const { root, hash } of hashes) {
  const dir = path.join(root, hash, "chatSessions");
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl") || x.endsWith(".json"))) {
    const sid = f.replace(/\.jsonl?$/, "");
    const resDir = path.join(wslRes, hash, "GitHub.copilot-chat", "chat-session-resources", sid);
    const ext = fs.existsSync(resDir) ? fs.readdirSync(resDir) : null;
    const names = new Map(), results = new Map(), stamps = new Map();
    const text = fs.readFileSync(path.join(dir, f), "utf-8");
    const hostVer = /"extensionVersion":\s*"([^"]+)"/.exec(text)?.[1] ?? "?";
    const walk = (o) => {
      if (Array.isArray(o)) { for (const v of o) walk(v); return; }
      if (!o || typeof o !== "object") return;
      const md = o.metadata;
      if (md && typeof md === "object" && Array.isArray(md.toolCallRounds)) {
        for (const r of md.toolCallRounds) for (const c of r.toolCalls ?? []) { names.set(c.id, c.name); stamps.set(c.id, r.timestamp ?? 0); }
        for (const [k, v] of Object.entries(md.toolCallResults ?? {})) results.set(k, v);
      }
      for (const v of Object.values(o)) walk(v);
    };
    for (const line of text.split("\n")) { if (line.trim()) { try { walk(JSON.parse(line)); } catch { /* partial line */ } } }

    let versus = 0, versusVer = null;
    for (const [id, r] of results) {
      const name = names.get(id) ?? "?";
      if (!/versus/i.test(name)) continue;
      if ((stamps.get(id) ?? 0) < since) continue;
      versus++;
      const body = (r.content ?? []).map((p) => (typeof p.value === "string" ? p.value : "")).join("");
      const v = /\| v(\d+\.\d+\.\d+)"/.exec(body)?.[1];
      if (v) versusVer = v;
      const tool = name.replace(/^mcp_[^_]+_/, "");
      const t = perTool.get(tool) ?? { calls: 0, maxChars: 0, externalized: 0, unknown: 0 };
      t.calls++;
      t.maxChars = Math.max(t.maxChars, body.length);
      if (ext === null) t.unknown++;
      else if (ext.some((e) => e.startsWith(id))) { t.externalized++; anyExternalized = true; }
      perTool.set(tool, t);
    }
    if (versus) {
      if (ext === null) unknownSessions++;
      console.log(
        `session ${sid.slice(0, 8)}  host copilot-chat ${hostVer}  Versus ${versusVer ? "v" + versusVer : "(no header)"}  ` +
        `${versus} Versus call(s)${ext === null ? "  [no resource dir: delivery unknown]" : ""}`
      );
    }
  }
}

console.log("\ntool                          calls  max chars  externalized  unknown");
for (const [tool, t] of [...perTool].sort()) {
  console.log(`${tool.padEnd(28)} ${String(t.calls).padStart(6)} ${String(t.maxChars).padStart(10)} ${String(t.externalized).padStart(13)} ${String(t.unknown).padStart(8)}`);
}
console.log(
  `\n${anyExternalized ? "FAIL — some Versus results did not reach the model inline." : "PASS — no Versus result was externalized."}` +
  (unknownSessions ? ` (${unknownSessions} session(s) without a resource directory: delivery unknown there.)` : "")
);
process.exit(anyExternalized ? 1 : 0);
