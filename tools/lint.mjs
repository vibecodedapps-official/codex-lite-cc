#!/usr/bin/env node
// Repository checks with no dependencies. Exits 1 listing every failure.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const fail = (msg) => failures.push(msg);
const rel = (p) => relative(root, p).split(sep).join("/");
const read = (p) => {
  try { return readFileSync(join(root, p), "utf8"); } catch (e) { fail(`${p}: cannot read (${e.code})`); return null; }
};
const json = (p) => {
  const s = read(p);
  try { return s === null ? null : JSON.parse(s); } catch (e) { fail(`${p}: invalid JSON (${e.message})`); return null; }
};
const walk = (dir, skip = () => false) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (skip(rel(p))) return [];
    return d.isDirectory() ? walk(p, skip) : [p];
  });
};

// 1. Syntax of every module.
const modules = ["plugins", "tests", "tools"].flatMap((d) => walk(join(root, d))).filter((p) => p.endsWith(".mjs"));
for (const p of modules) {
  const r = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
  if (r.status !== 0) fail(`${rel(p)}: node --check failed\n${(r.stderr || r.error?.message || "").trim()}`);
}

// 2. Runtime budget: exactly the two scripts, 650 lines together (counted as wc -l does).
const runtime = ["plugins/codex-lite/scripts/codex.mjs", "plugins/codex-lite/scripts/codex-lite.mjs"];
const extra = modules.map(rel).filter((p) => p.startsWith("plugins/") && !runtime.includes(p));
if (extra.length) fail(`runtime modules other than the two scripts: ${extra.join(", ")}`);
let lines = 0;
for (const p of runtime) {
  const s = read(p);
  if (s !== null) lines += s.split("\n").length - 1;
}
if (lines > 650) fail(`runtime scripts total ${lines} lines, budget is 650`);

// 3. Versions agree, and the README install block names this marketplace and plugin.
const pkg = json("package.json");
const plugin = json("plugins/codex-lite/.claude-plugin/plugin.json");
const market = json(".claude-plugin/marketplace.json");
const entry = market?.plugins?.find((p) => p.name === plugin?.name);
if (plugin && market && !entry) fail(`marketplace.json has no plugin named ${plugin.name}`);
if (pkg && plugin && entry && !(pkg.version === plugin.version && plugin.version === entry.version)) {
  fail(`versions differ: package.json ${pkg.version}, plugin.json ${plugin.version}, marketplace.json ${entry.version}`);
}
const readme = read("README.md");
if (readme !== null && plugin && market) {
  const repo = String(plugin.repository ?? "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  for (const line of [`/plugin marketplace add ${repo}`, `/plugin install ${plugin.name}@${market.name}`]) {
    if (!readme.split("\n").some((l) => l.trim() === line)) fail(`README.md install block lacks the line: ${line}`);
  }
}

// 4. Only do and setup are hidden from the model; ask and review must stay visible so a plain-words request can reach them.
const hidden = { ask: false, review: false, do: true, setup: true };
for (const [name, want] of Object.entries(hidden)) {
  const s = read(`plugins/codex-lite/commands/${name}.md`);
  if (s === null) continue;
  const front = s.split(/\r?\n---\r?\n/)[0];
  const has = /^disable-model-invocation:\s*true\s*$/m.test(front);
  if (has !== want) fail(`plugins/codex-lite/commands/${name}.md: disable-model-invocation must be ${want ? "set" : "absent"}`);
}

// 5. No file names a docs/*.md file listed in .git/info/exclude, or cites a numbered entry of one ("<name> 12").
// A fresh clone's exclude file lists none, so the check runs only in a working copy that has such files.
const excludes = join(root, ".git", "info", "exclude");
const stems = existsSync(excludes)
  ? readFileSync(excludes, "utf8").split("\n").map((l) => l.trim().match(/^docs\/([\w-]+)\.md$/)?.[1]).filter(Boolean) : [];
if (stems.length) {
  const named = new RegExp(`(${stems.join("|")})\\.md`);
  const numbered = new RegExp(`\\b(${stems.map((s) => s.replace(/s$/, "")).join("|")})s? \\d+`, "i");
  const skip = (p) => [".git", ".scratch", "node_modules"].includes(p) || p.endsWith(".DS_Store") || stems.some((s) => p === `docs/${s}.md`);
  for (const p of walk(root, skip)) {
    readFileSync(p, "utf8").split("\n").forEach((l, i) => {
      if (named.test(l) || numbered.test(l)) fail(`${rel(p)}:${i + 1}: names a locally excluded file: ${l.trim()}`);
    });
  }
}

if (failures.length) {
  console.error(`lint: ${failures.length} failure(s)\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`lint: ok (${modules.length} modules checked, runtime ${lines}/650 lines)`);
