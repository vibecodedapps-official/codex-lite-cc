// How the entry script finds Codex on Windows with no test override, through setup's first row. A copy of node.exe
// stands in for the npm install's codex.exe: its --version output proves which file ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, linkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli, withScratch } from './fixtures/harness.mjs';

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
