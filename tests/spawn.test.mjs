// The entry script run end to end against a fake Codex that records what it was given. Git is real, in scratch repos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ASK, FAKE, RESUME, SANDBOX, SCRIPT, THREAD, ID, alive, calls, cli, dead, pids, probeLeftovers, requestLeft, run, spawning, stdin, withScratch } from './fixtures/harness.mjs';

test('ask: the recorded argv and stdin match, and a good run renders the answer', spawning, withScratch((s) => {
  const request = 'say "hi" `x` $(id) \\ back\n--dangerously-leading-hyphen\n';
  const r = run(s, 'ask', { request });
  assert.deepEqual(calls(s), [ASK]);
  assert.equal(stdin(s), request);
  assert.equal(r.stdout, 'requested: codex exec --json --ignore-user-config -c approval_policy="never" -c sandbox_mode="read-only" -\n' +
    `cwd: ${s.repo}\n\nfake answer\n\nthread ${THREAD}\n${RESUME}\n`);
  assert.equal(r.status, 0);
  assert.equal(requestLeft(s), false);
}));

test('the same complete stream followed by exit 1 is a failure that prints Codex stderr', spawning, withScratch((s) => {
  const r = run(s, 'ask', { request: 'q', env: { FAKE_CODEX: 'exit1' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\n\ncodex-lite: the run failed: codex exited with status 1\nfake failure on stderr\n\n/);
  assert.doesNotMatch(r.stdout, /fake answer/);
}));

test('a message with no turn.completed and exit 0 is a failure', spawning, withScratch((s) => {
  const r = run(s, 'ask', { request: 'q', env: { FAKE_CODEX: 'no-turn' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /codex-lite: the run failed: no turn.completed event arrived\n/);
}));

test('turn.completed with no agent_message and exit 0 is a failure', spawning, withScratch((s) => {
  const r = run(s, 'ask', { request: 'q', env: { FAKE_CODEX: 'no-message' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /codex-lite: the run failed: no final message arrived\n/);
}));

test('a child that exits on stderr before reading a 1 MB stdin is a failure, with no resume line and no request left', spawning, withScratch((s) => {
  const r = run(s, 'ask', { request: 'x'.repeat(1 << 20), env: { FAKE_CODEX: 'stderr-early' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /codex-lite: the run failed: codex exited with status 1; no turn.completed event arrived; no final message arrived\n/);
  assert.match(r.stdout, /\nNot inside a trusted directory and --skip-git-repo-check was not specified.\n/);
  assert.doesNotMatch(r.stdout, /Resume:|thread /);
  assert.equal(requestLeft(s), false);
}));

test('a 1 MB request against a child that writes 1 MB before reading does not deadlock', spawning, withScratch((s) => {
  const r = run(s, 'ask', { request: 'y'.repeat(1 << 20), env: { FAKE_CODEX: 'floods-stdout', CODEX_LITE_TIMEOUT_MS: '20000' } });
  assert.equal(r.status, 0);
  assert.equal(stdin(s).length, 1048576);
  assert.match(r.stdout, /\n\nfake answer\n\n/);
}));

const refusesDo = (setup, pattern) => withScratch((s) => {
  const env = setup(s);
  const r = run(s, 'do', { request: 'go', env });
  assert.match(r.stdout, pattern);
  assert.equal(r.status, 1);
  assert.equal(calls(s).some((c) => c[0] === 'exec'), false);
  assert.deepEqual(probeLeftovers(s), [false, []]);
});

test('do refuses when the probe target cannot be written without a sandbox', spawning, refusesDo(
  (s) => ({ CODEX_LITE_PROBE_TARGET: join(s.root, 'missing', 'probe') }),
  /^codex-lite: do was not run: reachability check failed: .*\(ENOENT\)/));

test('do refuses when a sandboxed write inside the working directory fails', spawning, refusesDo(
  () => ({ FAKE_CODEX: 'sandbox-broken' }), /^codex-lite: do was not run: positive control failed: .* gave exit 71, file not created;/));

test('do refuses when a sandboxed write outside the workspace lands', spawning, refusesDo(
  () => ({ FAKE_CODEX: 'sandbox-open' }), /^codex-lite: do was not run: negative control failed: .* gave exit 0, file created;/));

test('do refuses from the home directory, saying the probe target is unusable rather than blaming the host', spawning, refusesDo(
  (s) => ({ HOME: s.repo }), /^codex-lite: do was not run: the probe target .* is inside this working directory .* This says nothing about whether the host can sandbox\n$/));

test('setup: version, login and both probe rows, and the printed allow rules', spawning, withScratch((s) => {
  const r = cli(s, ['setup', s.data], { cwd: s.plain });
  const [version, login, positive, negative] = calls(s);
  assert.deepEqual(version, ['--version']);
  assert.deepEqual(login, ['login', 'status']);
  assert.deepEqual(positive.slice(0, -1), SANDBOX);
  assert.equal(positive.at(-1).startsWith(`${s.plain}/.codex-lite-probe-`), true);
  assert.deepEqual(negative, [...SANDBOX, s.target]);
  assert.equal(r.stdout, 'codex: codex-cli 0.155.1\nlogin: Logged in using ChatGPT\n' +
    'sandbox: workspace-write proven: an inside write landed and an outside write was denied (EPERM)\n\n' +
    'Allow rules for this plugin. setup adds neither; add them to permissions.allow in your Claude Code settings if you want them:\n' +
    `  Edit(/${s.data}/**)\n  Bash(node "${SCRIPT}" *)\nThe Bash rule names the installed version's path, so it changes with every release.\n`);
  assert.equal(r.status, 0);
  assert.deepEqual(readdirSync(s.plain), []);
}));

test('by default each run probes its own file in the home directory', spawning, withScratch((s) => {
  const home = join(s.root, 'outside');
  cli(s, ['setup', s.data], { cwd: s.plain, env: { HOME: home, CODEX_LITE_PROBE_TARGET: '' } });
  assert.match(calls(s)[3].at(-1), new RegExp(`^${home}/\\.codex-lite-sandbox-probe-\\d+$`));
}));

test('setup prints the Bash rule for the script path as invoked, even through a symlinked plugin root', spawning, withScratch((s) => {
  const link = join(s.root, 'plugin-link');
  symlinkSync(dirname(dirname(SCRIPT)), link);
  const r = spawnSync(process.execPath, [join(link, 'scripts', 'codex-lite.mjs'), 'setup', s.data],
    { cwd: s.plain, encoding: 'utf8', env: { ...process.env, CODEX_LITE_CODEX_BIN: FAKE, CODEX_LITE_PROBE_TARGET: s.target } });
  assert.match(r.stdout, new RegExp(`\\n  Bash\\(node "${link}/scripts/codex-lite\\.mjs" \\*\\)\\n`));
}));

test('setup from the home directory reports the toolchain and says the probe target is unusable from here', spawning, withScratch((s) => {
  const r = cli(s, ['setup', s.data], { cwd: s.plain, env: { HOME: s.plain } });
  assert.match(r.stdout, /^codex: codex-cli 0.155.1\nlogin: Logged in using ChatGPT\nsandbox: the probe target .* cannot be tested from here;/);
  assert.equal(r.status, 1);
  assert.deepEqual(calls(s), [['--version'], ['login', 'status']]);
}));

test('setup: a --version that ignores SIGTERM gives a refusal naming it within 10 s of the deadline', spawning, withScratch((s) => {
  const r = cli(s, ['setup', s.data], { cwd: s.plain, env: { FAKE_CODEX: 'version-ignores-sigterm', CODEX_LITE_TIMEOUT_MS: '500' } });
  assert.match(r.stdout, /^codex: codex-lite: codex --version did not finish within 0.5 s and was stopped\nlogin: Logged in/);
  assert.equal(r.status, 1);
  assert.equal(r.ms < 10_500, true, `${r.ms} ms`);
  assert.equal(alive(pids(s)[0]), false);
}));

test('a run past its deadline has its whole process group killed, grandchild included', spawning, withScratch(async (s) => {
  const r = run(s, 'ask', { request: 'q', env: { FAKE_CODEX: 'hang', CODEX_LITE_TIMEOUT_MS: '1000' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\n\ncodex-lite: the run failed: timed out after 1 s; its process group was stopped\n/);
  assert.equal(await dead(pids(s)[0]), true);
}));

test('a child that ignores SIGTERM is killed by the escalation, within 10 s of the deadline', spawning, withScratch(async (s) => {
  const r = run(s, 'ask', { request: 'q', env: { FAKE_CODEX: 'ignores-sigterm', CODEX_LITE_TIMEOUT_MS: '1000' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /codex-lite: the run failed: timed out after 1 s; its process group was stopped\n/);
  assert.equal(r.ms < 11_000, true, `${r.ms} ms`);
  assert.equal(await dead(pids(s)[0]), true);
}));

test('a timed-out run whose own child ignores SIGTERM has that child killed too', spawning, withScratch(async (s) => {
  const r = run(s, 'ask', { request: 'q', env: { FAKE_CODEX: 'hang-stubborn-child', CODEX_LITE_TIMEOUT_MS: '1000' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /codex-lite: the run failed: timed out after 1 s; its process group was stopped\n/);
  assert.equal(await dead(pids(s)[0]), true);
}));

test('a background process left by a successful run is stopped before the result is printed', spawning, withScratch(async (s) => {
  const r = run(s, 'ask', { request: 'q', env: { FAKE_CODEX: 'leaves-stubborn-child' } });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(await dead(pids(s)[0]), true);
}));

test('an error Codex reports only in the JSON stream is printed with the failure', spawning, withScratch((s) => {
  const r = run(s, 'ask', { request: 'q', env: { FAKE_CODEX: 'turn-failed' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\n\ncodex-lite: the run failed: codex exited with status 1; no turn.completed event arrived; no final message arrived; codex reported: usage limit reached\n/);
}));

test('a child that exits 0 while its own child holds stdout renders within the drain bound', spawning, withScratch(async (s) => {
  try {
    const r = run(s, 'ask', { request: 'q', env: { FAKE_CODEX: 'holds-stdout' } });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\n\nfake answer\n\n/);
    assert.equal(r.ms < 6000, true, `${r.ms} ms`);
  } finally { for (const pid of pids(s)) try { process.kill(pid, 'SIGKILL'); } catch {} }
}));

test('a child that exits 0 just before the deadline, while its own child holds stdout, is not a timeout', spawning, withScratch(async (s) => {
  try {
    const r = run(s, 'ask', { request: 'q', env: { FAKE_CODEX: 'holds-stdout', CODEX_LITE_TIMEOUT_MS: '1000' } });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /\n\nfake answer\n\n/);
  } finally { for (const pid of pids(s)) try { process.kill(pid, 'SIGKILL'); } catch {} }
}));

test('a Codex that cannot be started is a failure for ask and a refusal naming the command for setup', spawning, withScratch((s) => {
  const env = { CODEX_LITE_CODEX_BIN: join(s.root, 'no-such-codex') };
  const r = run(s, 'ask', { request: 'q', env });
  assert.match(r.stdout, /\n\ncodex-lite: the run failed: could not start codex: spawn \S+no-such-codex ENOENT\n/);
  assert.equal(r.status, 1);
  assert.equal(requestLeft(s), false);
  const d = run(s, 'do', { request: 'go', env });
  assert.match(d.stdout, /^codex-lite: do was not run: could not start codex sandbox \(positive control\): spawn \S+no-such-codex ENOENT\n$/);
  assert.equal(d.status, 1);
  const setup = cli(s, ['setup', s.data], { cwd: s.plain, env });
  assert.match(setup.stdout, /^codex: codex-lite: could not start codex --version: spawn \S+no-such-codex ENOENT\nlogin: codex-lite: could not start codex login status: /);
  assert.equal(setup.status, 1);
}));

test('a session id carrying a command substitution is refused with nothing opened', spawning, withScratch((s) => {
  const planted = join(s.data, 'request-$(id)aaaa.txt');
  writeFileSync(planted, 'q');
  const r = cli(s, ['ask', s.data, '$(id)aaaa']);
  assert.equal(r.stdout, 'codex-lite: the session id is missing or malformed, so no request file was opened\n');
  assert.equal(r.status, 1);
  assert.equal(existsSync(planted), true);
  assert.deepEqual(calls(s), []);
}));

test('a relative data directory is refused', spawning, withScratch((s) => {
  const r = cli(s, ['ask', 'data', ID]);
  assert.equal(r.stdout, 'codex-lite: the plugin data directory must be an absolute path, not "data"\n');
  assert.equal(r.status, 1);
}));

test('a request file older than ten minutes is refused and deleted', spawning, withScratch((s) => {
  writeFileSync(join(s.data, `request-${ID}.txt`), 'q');
  const old = new Date(Date.now() - 11 * 60_000);
  utimesSync(join(s.data, `request-${ID}.txt`), old, old);
  const r = run(s, 'ask');
  assert.equal(r.stdout, 'codex-lite: the request file is 11 minutes old, so it was treated as abandoned and deleted; run the command again\n');
  assert.equal(r.status, 1);
  assert.equal(requestLeft(s), false);
  assert.deepEqual(calls(s), []);
}));

test('a missing request file is refused, for review as well as ask', spawning, withScratch((s) => {
  for (const command of ['ask', 'review']) {
    const r = run(s, command);
    assert.equal(r.stdout, `codex-lite: no request file at ${join(s.data, `request-${ID}.txt`)}; run the command again\n`);
    assert.equal(r.status, 1);
  }
  assert.deepEqual(calls(s), []);
}));

test('a whitespace-only request is refused and deleted', spawning, withScratch((s) => {
  const r = run(s, 'do', { request: ' \n\t\n', cwd: s.plain });
  assert.equal(r.stdout, 'codex-lite: the request is empty; nothing was sent to Codex\n');
  assert.equal(r.status, 1);
  assert.equal(requestLeft(s), false);
  assert.deepEqual(calls(s), []);
}));
