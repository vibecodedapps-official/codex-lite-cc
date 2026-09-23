// The git pre-checks and the do footer, against real scratch repositories and the fake Codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DO, RESUME, SANDBOX, THREAD, calls, cli, git, probeLeftovers, requestLeft, run, spawning, stdin, withScratch } from './fixtures/harness.mjs';

const REVIEW = ['exec', 'review', '--json', '--ignore-user-config', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"'];

// PATH shims: git logs each call and then runs the real git; id leaves a marker, so a ref run through a shell shows.
function shims(s) {
  const bin = join(s.root, 'bin');
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  mkdirSync(bin);
  const shim = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  shim('git', `printf '%s\\n' "$*" >> '${join(s.root, 'git.log')}'\nexec '${realGit}' "$@"`);
  shim('id', `touch '${join(s.root, 'id-ran')}'`);
  return { PATH: `${bin}:${process.env.PATH}` };
}
const gitCalls = (s) => (existsSync(join(s.root, 'git.log')) ? readFileSync(join(s.root, 'git.log'), 'utf8').trim().split('\n') : []);

test('review: the four rows reach Codex with literal argv, and a ref with shell syntax arrives whole with nothing run', spawning, withScratch((s) => {
  const env = shims(s);
  git(s.repo, 'branch', 'topic/$(id)');
  writeFileSync(join(s.repo, 'tracked.txt'), 'two\n');
  git(s.repo, 'commit', '-q', '-am', 'second');
  writeFileSync(join(s.repo, 'tracked.txt'), 'three\n');
  const rows = [
    ['', ['--uncommitted']],
    ['--model gpt-5\n', ['--uncommitted', '--model', 'gpt-5']],
    ['--base topic/$(id)', ['--base', 'topic/$(id)']],
    ['  --base\ttopic/$(id)\n--model gpt-5\n', ['--base', 'topic/$(id)', '--model', 'gpt-5']],
  ];
  const headers = [];
  for (const [request] of rows) {
    const r = run(s, 'review', { request, env });
    assert.equal(r.status, 0, r.stdout);
    headers.push(r.stdout.split('\n')[0]);
    assert.equal(requestLeft(s), false);
  }
  assert.deepEqual(calls(s), rows.map(([, tail]) => [...REVIEW, ...tail]));
  assert.deepEqual(headers, [
    'requested: codex exec review --json --ignore-user-config -c approval_policy="never" -c sandbox_mode="read-only" --uncommitted',
    'requested: codex exec review --json --ignore-user-config -c approval_policy="never" -c sandbox_mode="read-only" --uncommitted --model gpt-5',
    'requested: codex exec review --json --ignore-user-config -c approval_policy="never" -c sandbox_mode="read-only" --base topic/$(id)',
    'requested: codex exec review --json --ignore-user-config -c approval_policy="never" -c sandbox_mode="read-only" --base topic/$(id) --model gpt-5',
  ]);
  assert.equal(existsSync(join(s.root, 'id-ran')), false);
  // Control: the same shim does leave its marker when a shell runs id.
  execFileSync('/bin/sh', ['-c', 'id'], { env: { ...process.env, ...env } });
  assert.equal(existsSync(join(s.root, 'id-ran')), true);
}));

test('review: a value starting with a hyphen is refused before any git process or Codex starts', spawning, withScratch((s) => {
  const env = shims(s);
  const r = run(s, 'review', { request: '--base=--output=x', env });
  assert.equal(r.stdout, 'codex-lite: review arguments refused: --base "--output=x" is empty or starts with "-"; refused\n');
  assert.equal(r.status, 1);
  assert.deepEqual(gitCalls(s), []);
  assert.deepEqual(calls(s), []);
  assert.equal(requestLeft(s), false);
  // Control: the same shim does record git when a request gets that far.
  run(s, 'review', { request: '--base nope', env });
  assert.notDeepEqual(gitCalls(s), []);
}));

const refusesReview = (prepare, request, expected) => withScratch((s) => {
  prepare(s);
  const r = run(s, 'review', { request });
  assert.equal(r.stdout, expected);
  assert.equal(r.status, 1);
  assert.deepEqual(calls(s), []);
  assert.equal(requestLeft(s), false);
});

test('review --uncommitted in a clean repository is refused; an ignored file is not a change', spawning, refusesReview(
  (s) => writeFileSync(join(s.repo, '.env'), 'SECRET=1\n'), '',
  'codex-lite: nothing to review: the repository has no uncommitted changes\n'));

test('review --base with a ref that names no commit is refused', spawning, refusesReview(
  () => {}, '--base nope', 'codex-lite: base nope does not name a commit in this repository\n'));

test('review --base with a branch of unrelated history is refused', spawning, refusesReview(
  (s) => {
    git(s.repo, 'switch', '-q', '--orphan', 'unrelated');
    git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
    git(s.repo, 'switch', '-q', 'main');
  },
  '--base unrelated', 'codex-lite: base unrelated and HEAD have no merge base\n'));

test('review --base with no commits between the base and HEAD is refused', spawning, refusesReview(
  (s) => git(s.repo, 'branch', 'same'), '--base same', 'codex-lite: nothing to review: no differences between same and HEAD\n'));

// Two tracked directories: a subdirectory run must see the whole repository, not only its own directory.
function siblings(s) {
  for (const d of ['a', 'b']) {
    mkdirSync(join(s.repo, d));
    writeFileSync(join(s.repo, d, 'file.txt'), 'one\n');
  }
  git(s.repo, 'add', '.');
  git(s.repo, 'commit', '-q', '-m', 'siblings');
  writeFileSync(join(s.repo, 'b', 'file.txt'), 'changed\n');
  return join(s.repo, 'a');
}

test('review --uncommitted from a subdirectory sees a change in a sibling directory', spawning, withScratch((s) => {
  const r = run(s, 'review', { request: '', cwd: siblings(s) });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(calls(s), [[...REVIEW, '--uncommitted']]);
  assert.equal(r.stdout.split('\n')[1], `cwd: ${s.repo}/a`);
}));

test('do: the probe passes, the rows match, and the footer states the tree after the run', spawning, withScratch((s) => {
  writeFileSync(join(s.repo, 'tracked.txt'), 'modified before the run\n');
  const before = git(s.repo, 'rev-parse', '--short', 'HEAD').trim();
  const r = run(s, 'do', { request: 'fix it', env: { FAKE_CODEX: 'commits' } });
  const after = git(s.repo, 'rev-parse', '--short', 'HEAD').trim();
  const [positive, negative, turn] = calls(s);
  assert.deepEqual(positive.slice(0, -1), SANDBOX);
  assert.match(positive.at(-1), /\/\.codex-lite-probe-[A-Za-z0-9]{6}\/probe$/);
  assert.equal(positive.at(-1).startsWith(`${s.repo}/`), true);
  assert.deepEqual(negative, [...SANDBOX, s.target]);
  assert.deepEqual(turn, DO);
  assert.equal(stdin(s), 'fix it');
  assert.notEqual(before, after);
  assert.equal(r.stdout, 'requested: codex exec --json --ignore-user-config -c approval_policy="never" -c sandbox_mode="workspace-write" -\n' +
    `cwd: ${s.repo}\nsandbox: workspace-write proven on this host before the run; the system temp directory stays writable\n\nfake answer\n\n` +
    `HEAD ${before} before, ${after} after\nworking tree after the run:\n   M tracked.txt\n  !! .env\nthread ${THREAD}\n${RESUME}\n`);
  assert.equal(r.status, 0);
  assert.deepEqual(probeLeftovers(s), [false, []]);
}));

test('do from a subdirectory names it as cwd, probes under it, and lists the whole repository from its top', spawning, withScratch((s) => {
  const sub = siblings(s);
  const before = git(s.repo, 'rev-parse', '--short', 'HEAD').trim();
  const r = run(s, 'do', { request: 'go', cwd: sub, env: { FAKE_CODEX: 'commits' } });
  const after = git(s.repo, 'rev-parse', '--short', 'HEAD').trim();
  assert.equal(calls(s)[0].at(-1).startsWith(`${s.repo}/a/.codex-lite-probe-`), true);
  assert.notEqual(before, after);
  assert.equal(r.stdout, 'requested: codex exec --json --ignore-user-config -c approval_policy="never" -c sandbox_mode="workspace-write" -\n' +
    `cwd: ${s.repo}/a\nsandbox: workspace-write proven on this host before the run; the system temp directory stays writable\n\nfake answer\n\n` +
    `HEAD ${before} before, ${after} after\nworking tree after the run:\n   M b/file.txt\n  !! a/.env\nthread ${THREAD}\n${RESUME}\n`);
  assert.equal(r.status, 0);
}));

test('do: the tree listing stops at 50 lines and says how many were omitted', spawning, withScratch((s) => {
  mkdirSync(join(s.repo, 'ignored'));
  for (let i = 10; i < 70; i++) writeFileSync(join(s.repo, 'ignored', `f${i}`), '');
  const r = run(s, 'do', { request: 'go' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\n {2}!! ignored\/f59\n10 more lines omitted; run git status --porcelain --untracked-files=all --ignored to see them\nthread /);
  assert.equal(r.stdout.split('\n').filter((l) => l.startsWith('  !! ')).length, 50);
}));

test('outside a git repository ask, review and do are refused with Codex never started, and setup still runs', spawning, withScratch((s) => {
  for (const [command, request] of [['ask', 'q'], ['review', ''], ['do', 'go']]) {
    const r = run(s, command, { request, cwd: s.plain });
    assert.match(r.stdout, /^codex-lite: not inside a git repository, so nothing was run \(fatal: not a git repository/, command);
    assert.equal(r.status, 1, command);
    assert.equal(requestLeft(s), false, command);
  }
  assert.deepEqual(calls(s), []);
  assert.equal(cli(s, ['setup', s.data], { cwd: s.plain }).status, 0);
}));
