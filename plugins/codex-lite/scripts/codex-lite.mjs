#!/usr/bin/env node
// Entry: node codex-lite.mjs <review|ask|do> <dataDir> <sessionId>, or setup <dataDir>. Prints one result, exits 0 or 1.
// Or node codex-lite.mjs hook, the UserPromptSubmit hook: reads the event on stdin, prints a routing note or nothing, exits 0.
// The data directory arrives as an argument: inside the Bash tool the environment can carry another plugin's value.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { NPM_WIN32, WINDOWS_SANDBOXES, buildArgv, decideProbe, parseAskArgs, parseReviewArgs, readStream, requestedLine, resumeLine, validateRequestId,
  windowsSandboxSetting } from './codex.mjs';

const started = Date.now();
// Test-only seams, read once. CODEX_LITE_TIMEOUT_MS replaces both deadlines below.
const { CODEX_LITE_CODEX_BIN, CODEX_LITE_TIMEOUT_MS, CODEX_LITE_PROBE_TARGET } = process.env;
const override = Number(CODEX_LITE_TIMEOUT_MS) > 0 ? Number(CODEX_LITE_TIMEOUT_MS) : null;
const TURN_MS = override ?? 60 * 60_000;
const LOCAL_MS = override ?? 30_000;
const PROBE_TARGET = CODEX_LITE_PROBE_TARGET || join(homedir(), `.codex-lite-sandbox-probe-${process.pid}`);
const STALE_MS = 10 * 60_000;
const TREE_LINES = 50;
const POSIX = process.platform !== 'win32';

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };
const secs = (ms) => `${ms / 1000} s`;
const out = [];

// Every spawn goes through here, and spawn's own timeout option is not used: it signals once and then waits as long
// as the child lives. On POSIX the child leads its own process group and every signal goes to the group. The wait
// ends at exit plus a 2 s drain, not at close, which would wait for any descendant still holding the pipes; and it
// ends regardless 10 s after the deadline. Once the child exits, whatever it left in its group is stopped too.
function run(file, args, { ms, cwd, input, onStdout }) {
  return new Promise((resolve) => {
    const res = { code: null, signal: null, stdout: '', stderr: '', timedOut: false, stillRunning: false, spawnError: null, pid: undefined };
    const stdout = [], stderr = [], timers = [];
    const later = (delay, f) => timers.push(setTimeout(f, delay));
    let child, done = false;
    // A failed kill (ESRCH, or EPERM) is not fatal: the hard end below reports a process that may still be running.
    const kill = (signal) => { try { if (POSIX) process.kill(-child.pid, signal); else child.kill(); } catch {} };
    const finish = () => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      if (child && POSIX) kill('SIGKILL');
      res.stillRunning = !res.spawnError && child.exitCode === null && child.signalCode === null;
      for (const s of [child.stdin, child.stdout, child.stderr]) s?.destroy();
      child.unref();
      res.stdout = Buffer.concat(stdout).toString('utf8');
      res.stderr = Buffer.concat(stderr).toString('utf8');
      resolve(res);
    };
    try {
      child = spawn(file, args, { cwd, shell: false, detached: POSIX, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (e) { res.spawnError = e; return resolve(res); }
    res.pid = child.pid;
    child.stdout.on('data', (b) => (onStdout ? onStdout(b) : stdout.push(b)));
    child.stderr.on('data', (b) => stderr.push(b));
    child.on('error', (e) => { if (child.pid === undefined) { res.spawnError = e; finish(); } });
    child.on('exit', (code, signal) => {
      res.code = code; res.signal = signal;
      if (POSIX) kill('SIGTERM');
      later(2000, finish);
    });
    child.on('close', finish);
    later(ms, () => {
      if (child.exitCode !== null || child.signalCode !== null) return; // exited, and draining: not a timeout
      res.timedOut = true;
      kill('SIGTERM');
      later(5000, () => kill('SIGKILL'));
      later(10_000, finish);
    });
    if (child.stdin) {
      // EPIPE here means the child exited without reading its input; its exit status and stderr say why.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

// For commands that normally take milliseconds: failing to start or missing the deadline is a refusal naming them.
async function local(name, file, args, cwd) {
  const r = await run(file, args, { ms: LOCAL_MS, cwd });
  if (r.spawnError) refuse(`could not start ${name}: ${r.spawnError.message}`);
  if (r.timedOut) refuse(`${name} did not finish within ${secs(LOCAL_MS)}${r.stillRunning ? `; it may still be running as pid ${r.pid}` : ' and was stopped'}`);
  return r;
}
const git = (args, cwd) => local(`git ${args.join(' ')}`, 'git', args, cwd);

// On Windows only a codex.exe is run: the npm launcher is a .cmd, which cannot be started without a shell. A codex.exe
// on PATH wins; else the first codex.cmd must be an npm install, and its binary is found the way bin/codex.js finds it.
// Running the binary rather than bin/codex.js keeps a timeout's kill on Codex itself, not on a node wrapper.
function resolveCodex() {
  if (CODEX_LITE_CODEX_BIN) return CODEX_LITE_CODEX_BIN;
  if (POSIX) return 'codex';
  const dirs = (process.env.PATH ?? '').split(delimiter).map((d) => d.replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const exe = dirs.map((d) => join(d, 'codex.exe')).find((p) => existsSync(p));
  if (exe) return exe;
  const dir = dirs.find((d) => existsSync(join(d, 'codex.cmd')));
  if (!dir) refuse('neither codex.exe nor the npm codex.cmd was found on PATH; install Codex');
  const launcher = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (!existsSync(launcher)) {
    refuse(`the codex.cmd in ${dir} is not an npm install of Codex (no ${launcher}); pnpm, bun and other installers are not ` +
      'supported; install Codex with npm install -g @openai/codex, or the standalone Codex for Windows');
  }
  const target = NPM_WIN32[process.arch];
  if (!target) refuse(`the npm install of Codex has no Windows binary for ${process.arch}`);
  // Only a platform package that cannot be resolved falls back to the package's own vendor directory, as in the launcher.
  const script = realpathSync(launcher);
  let vendor;
  try { vendor = join(dirname(createRequire(script).resolve(`${target[0]}/package.json`)), 'vendor'); } catch {
    vendor = join(dirname(dirname(script)), 'vendor');
  }
  const bin = join(vendor, target[1], 'bin', 'codex.exe');
  if (!existsSync(bin)) refuse(`the npm install of Codex in ${dir} has no ${bin}; reinstall it with npm install -g @openai/codex`);
  return bin;
}

// On Windows, Codex's sandbox denies every write and every command unless its mode is set, and --ignore-user-config
// drops the user's setting. So this one key is read from the Codex config and passed on each call.
function windowsSandbox() {
  if (POSIX) return {};
  const file = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
  let value;
  try { value = windowsSandboxSetting(readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') refuse(`could not read ${file}: ${e.message}`);
  }
  if (WINDOWS_SANDBOXES.includes(value)) return { value, file };
  const found = value === undefined ? 'is not set' : `is ${JSON.stringify(value)}, which is neither "unelevated" nor "elevated"`;
  return { file, problem: `Codex's Windows sandbox mode ${found} in ${file}, and without it Codex's sandbox denies every write and ` +
    'every command; add a [windows] table with sandbox = "unelevated" there, or "elevated" if you have admin rights' };
}

// The file is deleted on every path: a leftover blocks the next Write with an error that names nothing.
function takeRequest(dataDir, id) {
  const file = join(dataDir, `request-${id}.txt`);
  try {
    const age = started - statSync(file).mtimeMs;
    if (age > STALE_MS) refuse(`the request file is ${Math.floor(age / 60_000)} minutes old, so it was treated as abandoned and deleted; run the command again`);
    return readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') refuse(`no request file at ${file}; run the command again`);
    throw e;
  } finally { rmSync(file, { force: true }); }
}

async function reviewChecks(base, cwd, top) {
  if (base === undefined) {
    // --uncommitted reviews the whole repository even from a subdirectory, so ask about the whole repository.
    const s = await git(['status', '--porcelain', '--untracked-files=all'], top);
    if (s.code !== 0) refuse(`git status failed: ${s.stderr.trim()}`);
    if (!s.stdout.trim()) refuse('nothing to review: the repository has no uncommitted changes');
    return;
  }
  const v = await git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], cwd);
  if (v.code !== 0) refuse(`base ${base} does not name a commit in this repository`);
  const m = await git(['merge-base', base, 'HEAD'], cwd);
  if (m.code === 1) refuse(`base ${base} and HEAD have no merge base`);
  if (m.code !== 0) refuse(`git merge-base failed: ${m.stderr.trim()}`);
  // diff --quiet exits 1 when there are differences, the case that proceeds, and 0 when the range is empty.
  const d = await git(['diff', '--quiet', `${base}...HEAD`], cwd);
  if (d.code === 0) refuse(`nothing to review: no differences between ${base} and HEAD`);
  if (d.code !== 1) refuse(`git diff failed: ${d.stderr.trim()}`);
}

const real = (p) => { try { return realpathSync(p); } catch { return p; } };

// Three checks: the target is writable without a sandbox, a sandboxed write inside the working directory lands, and
// a sandboxed write to the target is denied. Every file any of them creates is removed.
async function probe(codex, cwd, windowsSandbox) {
  const rel = relative(real(cwd), real(homedir()));
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    return { pass: false, reason: `the probe target ${PROBE_TARGET} is inside this working directory (your home directory or one of its ` +
      'parents), so the sandbox cannot be tested from here; run from a project directory. This says nothing about whether the host can sandbox' };
  }
  try { writeFileSync(PROBE_TARGET, 'x'); rmSync(PROBE_TARGET); } catch (e) { return decideProbe({ reachability: { ok: false, code: e.code } }); }
  let dir;
  try {
    try { dir = mkdtempSync(join(cwd, '.codex-lite-probe-')); } catch (e) {
      return { pass: false, reason: `the positive control could not create its temp directory under ${cwd} (${e.code}), so the sandbox ` +
        'cannot be tested from here. This says nothing about whether the host can sandbox' };
    }
    const control = async (name, target) => {
      const r = await local(`codex sandbox (${name})`, codex, buildArgv('sandbox', { execPath: process.execPath, target, windowsSandbox }), cwd);
      return { exit: r.code, created: existsSync(target), code: r.stderr.trim() };
    };
    const positive = await control('positive control', join(dir, 'probe'));
    const negative = await control('negative control', PROBE_TARGET);
    return decideProbe({ reachability: { ok: true }, positive, negative });
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
    rmSync(PROBE_TARGET, { force: true });
  }
}

const head = async (cwd) => {
  const r = await git(['rev-parse', '--short', 'HEAD'], cwd);
  return r.code === 0 ? r.stdout.trim() : 'none';
};

// The tree as it stands after the run, not a difference: a difference misses files that were already modified,
// commits, and ignored paths. Git lists tracked, then untracked, then ignored, so the cap drops ignored lines first.
async function treeFooter(cwd, before) {
  const after = await head(cwd);
  const s = await git(['status', '--porcelain', '--untracked-files=all', '--ignored'], cwd);
  if (s.code !== 0) refuse(`git status after the run failed: ${s.stderr.trim()}`);
  const lines = s.stdout.split('\n').filter((l) => l !== '');
  return [`HEAD ${before} before, ${after} after`,
    lines.length ? 'working tree after the run:' : 'working tree after the run: clean, nothing untracked or ignored',
    ...lines.slice(0, TREE_LINES).map((l) => `  ${l}`),
    ...(lines.length > TREE_LINES ? [`${lines.length - TREE_LINES} more lines omitted; run git status --porcelain --untracked-files=all --ignored to see them`] : [])];
}

// Each condition fails the run on its own, whatever the others say.
function failures(r) {
  if (r.spawnError) return [`could not start codex: ${r.spawnError.message}`];
  if (r.timedOut) {
    return [`timed out after ${secs(TURN_MS)}; ${r.stillRunning ? `codex may still be running as pid ${r.pid}` : POSIX ? 'its process group was stopped' : 'codex was stopped, but on Windows its child processes may still be running'}`];
  }
  return [r.code !== 0 && (r.signal ? `codex was ended by ${r.signal}` : `codex exited with status ${r.code}`),
    !r.sawTurnCompleted && 'no turn.completed event arrived', r.finalMessage === null && 'no final message arrived',
    ...r.errors.map((e) => `codex reported: ${e}`)].filter(Boolean);
}

async function main() {
  const [command, dataDir, id] = process.argv.slice(2);
  if (!['review', 'ask', 'do', 'setup'].includes(command)) refuse(`unknown command ${JSON.stringify(command)}; expected review, ask, do or setup`);
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir)) refuse(`the plugin data directory must be an absolute path, not ${JSON.stringify(dataDir)}`);
  if (command === 'setup') return setup(dataDir);
  // Before any filesystem access: the id is joined into a path that is then deleted.
  if (!validateRequestId(id)) refuse('the session id is missing or malformed, so no request file was opened');
  const text = takeRequest(dataDir, id);
  let args = {}, argv;
  try { args = command === 'review' ? parseReviewArgs(text) : command === 'ask' ? parseAskArgs(text) : {}; } catch (e) { refuse(`${command} arguments refused: ${e.message}`); }
  const input = command === 'ask' ? args.question : text;
  if (command !== 'review' && !input.trim()) refuse('the request is empty; nothing was sent to Codex');
  const win = windowsSandbox();
  if (command === 'do' && win.problem) refuse(`do was not run: ${win.problem}`);
  try { argv = buildArgv(command, { ...args, windowsSandbox: win.value }); } catch (e) { refuse(`${command} arguments refused: ${e.message}`); }
  const codex = resolveCodex();
  const cwd = process.cwd();
  const top = await git(['rev-parse', '--show-toplevel'], cwd);
  if (top.code !== 0) refuse(`not inside a git repository, so nothing was run (${top.stderr.trim()})`);
  let before;
  if (command === 'review') await reviewChecks(args.base, cwd, top.stdout.trim());
  if (command === 'do') {
    const p = await probe(codex, cwd, win.value).catch((e) => { if (e instanceof Refusal) return { reason: e.message }; throw e; });
    if (!p.pass) refuse(`do was not run: ${p.reason}`);
    before = await head(cwd);
  }
  const reader = readStream();
  const r = await run(codex, argv, { ms: TURN_MS, cwd, input: command === 'review' ? undefined : input, onStdout: (b) => reader.write(b) });
  Object.assign(r, reader.end());
  const why = failures(r);
  out.push(requestedLine(argv), `cwd: ${cwd}`);
  if (win.problem) out.push(`codex-lite: warning: ${win.problem}`);
  if (command === 'do') out.push('sandbox: workspace-write proven on this host before the run; the system temp directory stays writable');
  out.push('', ...(why.length ? [`codex-lite: the run failed: ${why.join('; ')}`, ...(r.stderr ? [r.stderr.replace(/\n$/, '')] : [])] : [r.finalMessage]), '');
  if (command === 'do') {
    try { out.push(...await treeFooter(cwd, before)); } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      out.push(`codex-lite: ${e.message}`);
      why.push(e.message);
    }
  }
  if (r.unparseableLines) out.push(`unparseable stream lines: ${r.unparseableLines}`);
  if (r.threadId) out.push(`thread ${r.threadId}`);
  const resume = resumeLine(r.threadId, win.value);
  if (resume) out.push(`Resume: ${resume}`);
  return why.length === 0;
}

// Reports each check whatever the others found. Edits no settings; prints the allow rules for the user to add.
async function setup(dataDir) {
  const cwd = process.cwd();
  let ok = true, codex;
  const check = async (label, f) => {
    try {
      const [pass, text] = await f();
      ok &&= pass;
      out.push(`${label}: ${text}`);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      ok = false;
      out.push(`${label}: codex-lite: ${e.message}`);
    }
  };
  const said = (r) => (r.stdout + r.stderr).trim() || `(no output, exit ${r.code})`;
  await check('codex', async () => {
    codex = resolveCodex();
    const r = await local('codex --version', codex, buildArgv('version'), cwd);
    return [r.code === 0, said(r)];
  });
  // Stays null on Windows when the row below fails, whether by a missing mode or an unreadable config.
  let win = POSIX ? {} : null;
  if (!POSIX) {
    await check('windows sandbox', async () => {
      const w = windowsSandbox();
      if (!w.problem) win = w;
      return [!w.problem, w.problem ?? `${w.value}, from ${w.file}`];
    });
  }
  if (codex) {
    await check('login', async () => {
      const r = await local('codex login status', codex, buildArgv('login'), cwd);
      return [r.code === 0, r.code === 0 ? said(r) : `not logged in: ${said(r)}; run codex login`];
    });
    await check('sandbox', async () => {
      if (!win) return [false, 'not tested until the windows sandbox row passes'];
      const p = await probe(codex, cwd, win.value);
      return [p.pass, p.reason];
    });
  }
  // Claude Code permission rules write an absolute path with a leading //; Windows paths as //c/Users/...
  const abs = POSIX ? dataDir.replace(/\/+$/, '') : `/${dataDir.replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase()).replaceAll('\\', '/').replace(/\/+$/, '')}`;
  // The Bash rule matches the command as the command files write it: Claude Code substitutes the plugin root with forward
  // slashes, on Windows too, while Node resolves argv[1] with backslashes. It names the version directory: a * in the
  // path would also match a sibling directory or a .. path.
  const root = POSIX ? dirname(dirname(process.argv[1])) : dirname(dirname(process.argv[1])).replaceAll('\\', '/');
  const rules = [`Edit(/${abs}/**)`, `Bash(node "${root}/scripts/codex-lite.mjs" *)`];
  out.push('', 'Allow rules for this plugin, as JSON strings. setup adds neither; to use them, paste them into the permissions.allow ' +
    'array in your Claude Code settings:', ...rules.map((r, i) => `  ${JSON.stringify(r)}${i < rules.length - 1 ? ',' : ''}`),
  'The Bash rule names the installed version\'s path, so it changes with every release.');
  return ok;
}

const ROUTING = 'Use codex-lite for Codex requests: ask for questions, plan critiques, and second opinions; review only for working-tree or ' +
  'base-ref diffs. Put an explicit model choice first as --model <name>. For file changes, direct the user to /codex-lite:do <task>; for ' +
  'setup checks, /codex-lite:setup. Do not invoke Codex directly.';

// Plain stdout from a UserPromptSubmit hook becomes context for Claude. A typed /codex-lite: command already routes itself.
// Missing or malformed input prints nothing: a hook must never block or fail a prompt.
async function hook() {
  let prompt;
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    prompt = JSON.parse(Buffer.concat(chunks).toString('utf8')).prompt;
  } catch { return; }
  if (typeof prompt === 'string' && /codex/i.test(prompt) && !prompt.trim().startsWith('/codex-lite:')) process.stdout.write(`${ROUTING}\n`);
}

if (process.argv[2] === 'hook') hook().catch((e) => process.stderr.write(`codex-lite: hook error: ${e?.stack ?? e}\n`));
else main().then((ok) => { process.exitCode = ok ? 0 : 1; }, (e) => {
  out.push(e instanceof Refusal ? `codex-lite: ${e.message}` : `codex-lite: unexpected error: ${e?.stack ?? e}`);
  process.exitCode = 1;
}).finally(() => process.stdout.write(`${out.join('\n')}\n`));
