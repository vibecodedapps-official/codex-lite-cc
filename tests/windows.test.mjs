// How the entry script finds Codex on Windows with no test override, through setup's first row. A copy of node.exe
// stands in for the npm install's codex.exe: its --version output proves which file ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, linkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SANDBOX, calls, cli, run, withScratch } from './fixtures/harness.mjs';

const windows = { skip: process.platform !== 'win32' && 'Codex is looked up on PATH only on Windows' };
const TARGET = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' }[process.arch];
const PLATFORM = `codex-win32-${process.arch}`;

// An npm global prefix as npm install -g @openai/codex lays it out, the platform package nested under the main one.
function npmPrefix(s, { platformPackage = true } = {}) {
  const prefix = join(s.root, 'npm prefix');
  const pkg = join(prefix, 'node_modules', '@openai', 'codex');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(prefix, 'codex.cmd'), '@ECHO off\r\n');
  writeFileSync(join(pkg, 'bin', 'codex.js'), '');
  if (platformPackage) {
    const platform = join(pkg, 'node_modules', '@openai', PLATFORM);
    const bin = join(platform, 'vendor', TARGET, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(platform, 'package.json'), `{"name":"@openai/${PLATFORM}"}`);
    try { linkSync(process.execPath, join(bin, 'codex.exe')); } catch { copyFileSync(process.execPath, join(bin, 'codex.exe')); }
  }
  return prefix;
}

// PATH holds only the given directory. Windows spells the variable Path, and a second spelling would be ambiguous.
const setup = (s, dir) => {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return cli(s, ['setup', s.data], { cwd: s.plain, env: { CODEX_LITE_CODEX_BIN: '', [key]: dir } }).stdout.split('\n')[0];
};

test('an npm install on PATH runs the codex.exe inside its platform package', windows, withScratch((s) => {
  assert.equal(setup(s, npmPrefix(s)), `codex: ${process.version}`);
}));

test('an npm install whose platform package is missing is refused, naming the binary it looked for', windows, withScratch((s) => {
  const prefix = npmPrefix(s, { platformPackage: false });
  assert.equal(setup(s, prefix), `codex: codex-lite: the npm install of Codex in ${prefix} has no ` +
    `${join(prefix, 'node_modules', '@openai', 'codex', 'vendor', TARGET, 'bin', 'codex.exe')}; reinstall it with npm install -g @openai/codex`);
}));

test('a codex.cmd that is not an npm install is refused', windows, withScratch((s) => {
  const dir = join(s.root, 'other');
  mkdirSync(dir);
  writeFileSync(join(dir, 'codex.cmd'), '@ECHO off\r\n');
  assert.equal(setup(s, dir), `codex: codex-lite: the codex.cmd in ${dir} is not an npm install of Codex ` +
    `(no ${join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')}); pnpm, bun and other installers are not supported; ` +
    'install Codex with npm install -g @openai/codex, or the standalone Codex for Windows');
}));

// Node stands in for Codex: these runs stop, or fail, before anything depends on what Codex says.
const unset = (file) => `Codex's Windows sandbox mode is not set in ${file}, and without it Codex's sandbox denies every write and every ` +
  'command; add a [windows] table with sandbox = "unelevated" there, or "elevated" if you have admin rights';

test('setup reports the Windows sandbox mode from $CODEX_HOME/config.toml, or that it is not set', windows, withScratch((s) => {
  const row = (env) => cli(s, ['setup', s.data], { cwd: s.plain, env: { CODEX_LITE_CODEX_BIN: process.execPath, ...env } }).stdout.split('\n')[1];
  writeFileSync(join(s.data, 'config.toml'), '[windows]\r\nsandbox = "elevated"\r\n');
  assert.equal(row({ CODEX_HOME: s.data }), `windows sandbox: elevated, from ${join(s.data, 'config.toml')}`);
  assert.equal(row({ CODEX_HOME: s.plain }), `windows sandbox: ${unset(join(s.plain, 'config.toml'))}`);
}));

test('do refuses before running Codex when the Windows sandbox mode is not set', windows, withScratch((s) => {
  const r = run(s, 'do', { request: 'go', env: { CODEX_LITE_CODEX_BIN: process.execPath, CODEX_HOME: s.plain } });
  assert.equal(r.stdout, `codex-lite: do was not run: ${unset(join(s.plain, 'config.toml'))}\n`);
  assert.equal(r.status, 1);
}));

test('ask runs without the Windows sandbox mode but warns', windows, withScratch((s) => {
  const r = run(s, 'ask', { request: 'q', env: { CODEX_LITE_CODEX_BIN: process.execPath, CODEX_HOME: s.plain } });
  assert.equal(r.stdout.split('\n')[2], `codex-lite: warning: ${unset(join(s.plain, 'config.toml'))}`);
}));

test('a configured Windows sandbox mode reaches the Codex command line', windows, withScratch((s) => {
  writeFileSync(join(s.data, 'config.toml'), '[windows]\nsandbox = "elevated"\n');
  const r = run(s, 'ask', { request: 'q', env: { CODEX_LITE_CODEX_BIN: process.execPath, CODEX_HOME: s.data } });
  assert.equal(r.stdout.split('\n')[0], 'requested: codex exec --json --ignore-user-config -c approval_policy="never" ' +
    '-c sandbox_mode="read-only" -c windows.sandbox="elevated" -');
}));

test('do passes a configured Windows sandbox mode to both probe controls and runs', windows, withScratch((s) => {
  writeFileSync(join(s.data, 'config.toml'), '[windows]\nsandbox = "elevated"\n');
  const shim = pathToFileURL(fileURLToPath(new URL('./fixtures/node-as-codex.mjs', import.meta.url))).href;
  const r = run(s, 'do', { request: 'go', env: { CODEX_LITE_CODEX_BIN: process.execPath, CODEX_HOME: s.data, NODE_OPTIONS: `--import "${shim}"` } });
  const [positive, negative] = calls(s);
  const probe = [...SANDBOX.slice(0, 5), '-c', 'windows.sandbox="elevated"', ...SANDBOX.slice(5)];
  assert.deepEqual(positive.slice(0, -1), probe);
  assert.deepEqual(negative, [...probe, s.target]);
  assert.equal(r.stdout.split('\n')[2], 'sandbox: workspace-write proven on this host before the run; the system temp directory stays writable');
  assert.equal(r.status, 0);
}));

// Claude Code writes the plugin root into the command with forward slashes, so the rule must use them to match.
test('setup prints the Bash rule with a forward-slash plugin root on Windows', windows, withScratch((s) => {
  const r = cli(s, ['setup', s.data], { cwd: s.plain, env: { CODEX_LITE_CODEX_BIN: process.execPath, CODEX_HOME: s.data } });
  const rule = r.stdout.split('\n').find((l) => l.startsWith('  "Bash('));
  assert.match(rule, /^  "Bash\(node \\"[A-Za-z]:\/[^\\"]*\/plugins\/codex-lite\/scripts\/codex-lite\.mjs\\" \*\)"$/);
}));

test('setup does not run the sandbox probe when the Codex config cannot be read', windows, withScratch((s) => {
  mkdirSync(join(s.data, 'config.toml'));
  const r = cli(s, ['setup', s.data], { cwd: s.plain, env: { CODEX_LITE_CODEX_BIN: process.execPath, CODEX_HOME: s.data } });
  assert.match(r.stdout, /\nwindows sandbox: codex-lite: could not read .*config\.toml: EISDIR/);
  assert.match(r.stdout, /\nsandbox: not tested until the windows sandbox row passes\n/);
}));
