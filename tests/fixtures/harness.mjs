// Shared by the test files: scratch repositories, the entry script run with the fake Codex, and what the fake recorded.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT = fileURLToPath(new URL('../../plugins/codex-lite/scripts/codex-lite.mjs', import.meta.url));
export const FAKE = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
export const ID = '5f0c8a4e-9d1b-4c2a-8e7f-3b6d2a1c0e9f';
export const THREAD = '01a0cc8d-ada9-7501-a8e1-f64ad8e79180';
export const RESUME = `Resume: codex exec resume ${THREAD} --json --ignore-user-config -c 'approval_policy="never"' -c 'sandbox_mode="read-only"' 'your follow-up here'`;
export const ONE_LINER = 'try{require("fs").writeFileSync(process.argv[1],"x");process.exit(0)}catch(e){' +
  'process.stderr.write(String(e&&e.code));process.exit(e&&(e.code==="EPERM"||e.code==="EACCES")?42:9)}';
export const ASK = ['exec', '--json', '--ignore-user-config', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '-'];
export const DO = ['exec', '--json', '--ignore-user-config', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"', '-'];
export const SANDBOX = ['sandbox', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', '--', process.execPath, '-e', ONE_LINER];
export const spawning = { skip: process.platform === 'win32' && 'a .mjs fake Codex is not an executable image, so it cannot be spawned with shell:false on Windows' };

export const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8' });

// A repository with one commit, a data directory, and an outside directory holding the probe target.
export function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-lite-test-')));
  const s = { root, repo: join(root, 'repo'), data: join(root, 'data'), plain: join(root, 'plain'), target: join(root, 'outside', 'probe') };
  for (const d of [s.repo, s.data, s.plain, join(root, 'outside')]) mkdirSync(d);
  writeFileSync(join(s.repo, 'tracked.txt'), 'one\n');
  writeFileSync(join(s.repo, '.gitignore'), '.env\nignored/\n');
  git(s.repo, 'init', '-q', '-b', 'main');
  git(s.repo, 'add', '.');
  git(s.repo, 'commit', '-q', '-m', 'first');
  return s;
}

export function cli(s, argv, { request, input, env = {}, cwd = s.repo } = {}) {
  if (request !== undefined) writeFileSync(join(s.data, `request-${ID}.txt`), request);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], {
    cwd, input, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 << 20,
    env: { ...process.env, CODEX_LITE_CODEX_BIN: FAKE, CODEX_LITE_PROBE_TARGET: s.target, CODEX_LITE_TIMEOUT_MS: '',
      FAKE_CODEX: '', FAKE_CODEX_ARGV: join(s.root, 'argv.jsonl'), FAKE_CODEX_STDIN: join(s.root, 'stdin'), FAKE_CODEX_PIDS: join(s.root, 'pids'), ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
}
export const run = (s, command, options) => cli(s, [command, s.data, ID], options);
export const calls = (s) => (existsSync(join(s.root, 'argv.jsonl')) ? readFileSync(join(s.root, 'argv.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
export const stdin = (s) => readFileSync(join(s.root, 'stdin'), 'utf8');
export const pids = (s) => readFileSync(join(s.root, 'pids'), 'utf8').trim().split('\n').map(Number);
export const requestLeft = (s) => existsSync(join(s.data, `request-${ID}.txt`));
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export async function dead(pid) {
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}
export const probeLeftovers = (s) => [existsSync(s.target), readdirSync(s.repo).filter((n) => n.startsWith('.codex-lite-probe-'))];
export const withScratch = (f) => async () => { const s = scratch(); try { await f(s); } finally { rmSync(s.root, { recursive: true, force: true }); } };
