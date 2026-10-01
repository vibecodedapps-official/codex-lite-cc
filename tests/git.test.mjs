// The git pre-checks and the do footer, against real scratch repositories and the fake Codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DO, RESUME, SANDBOX, THREAD, calls, cli, cwds, git, probeLeftovers, requestLeft, run, spawning, stdin, withScratch } from './fixtures/harness.mjs';

const REVIEW = ['exec', 'review', '--json', '--ignore-user-config', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"'];

// PATH shims: git logs each call and then runs the real git; id leaves a marker, so a ref run through a shell shows.
function shims(s, gitFirst = '') {
  const bin = join(s.root, 'bin');
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  mkdirSync(bin);
  const shim = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  shim('git', `printf '%s\\n' "$*" >> '${join(s.root, 'git.log')}'\n${gitFirst}exec '${realGit}' "$@"`);
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
  assert.equal(r.stdout, 'codex-lite: review arguments refused: --base "--output=x" is empty or starts with "-"; refused\nstatus: refused\n');
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
  'codex-lite: nothing to review: the repository has no uncommitted changes\nstatus: refused\n'));

test('review --base with a ref that names no commit is refused', spawning, refusesReview(
  () => {}, '--base nope', 'codex-lite: base nope does not name a commit in this repository\nstatus: refused\n'));

test('review --base with a branch of unrelated history is refused', spawning, refusesReview(
  (s) => {
    git(s.repo, 'switch', '-q', '--orphan', 'unrelated');
    git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
    git(s.repo, 'switch', '-q', 'main');
  },
  '--base unrelated', 'codex-lite: base unrelated and HEAD have no merge base\nstatus: refused\n'));

// review --base compares the merge base of the base and HEAD with the working tree, as Codex does.
const NOTHING = (base) => `codex-lite: nothing to review: no tracked differences between the merge base of ${base} and HEAD and the working tree; ` +
  'untracked files are not compared, git add them first\nstatus: refused\n';
const reviewsBase = (prepare, base) => withScratch((s) => {
  prepare(s);
  const r = run(s, 'review', { request: `--base ${base}` });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(calls(s), [[...REVIEW, '--base', base]]);
});
// A second branch whose only commit changes tracked.txt, left checked out on main.
const ahead = (s) => {
  git(s.repo, 'switch', '-q', '-c', 'ahead');
  writeFileSync(join(s.repo, 'tracked.txt'), 'base only\n');
  git(s.repo, 'commit', '-q', '-am', 'base only');
  git(s.repo, 'switch', '-q', 'main');
};

test('review --base equal to HEAD with a clean tree is refused', spawning, refusesReview(
  (s) => { git(s.repo, 'branch', 'same'); }, '--base same', NOTHING('same')));

test('review --base equal to HEAD with only an untracked file is refused', spawning, refusesReview(
  (s) => { git(s.repo, 'branch', 'same'); writeFileSync(join(s.repo, 'new.txt'), 'new\n'); }, '--base same', NOTHING('same')));

test('review --base equal to HEAD with a modified tracked file proceeds', spawning, reviewsBase(
  (s) => { git(s.repo, 'branch', 'same'); writeFileSync(join(s.repo, 'tracked.txt'), 'two\n'); }, 'same'));

test('review --base equal to HEAD with a staged new file proceeds', spawning, reviewsBase(
  (s) => { git(s.repo, 'branch', 'same'); writeFileSync(join(s.repo, 'new.txt'), 'new\n'); git(s.repo, 'add', 'new.txt'); }, 'same'));

test('review --base equal to HEAD with a staged deletion proceeds', spawning, reviewsBase(
  (s) => { git(s.repo, 'branch', 'same'); git(s.repo, 'rm', '-q', 'tracked.txt'); }, 'same'));

test('review --base equal to HEAD with a file removed from the index but left on disk proceeds', spawning, reviewsBase(
  (s) => { git(s.repo, 'branch', 'same'); git(s.repo, 'rm', '-q', '--cached', 'tracked.txt'); }, 'same'));

test('review --base equal to HEAD with a staged rename proceeds', spawning, reviewsBase(
  (s) => { git(s.repo, 'branch', 'same'); git(s.repo, 'mv', 'tracked.txt', 'renamed.txt'); }, 'same'));

test('review --base behind HEAD with commits only and a clean tree proceeds', spawning, reviewsBase(
  (s) => {
    git(s.repo, 'branch', 'old');
    writeFileSync(join(s.repo, 'tracked.txt'), 'two\n');
    git(s.repo, 'commit', '-q', '-am', 'second');
  }, 'old'));

test('review --base ahead of HEAD with a clean tree is refused: the merge base is HEAD', spawning, refusesReview(
  ahead, '--base ahead', NOTHING('ahead')));

test('review --base ahead of HEAD with a tracked change proceeds', spawning, reviewsBase(
  (s) => { ahead(s); writeFileSync(join(s.repo, '.gitignore'), 'changed\n'); }, 'ahead'));

test('review --base on a diverged branch ignores the base-only change and proceeds on a working-tree change', spawning, withScratch((s) => {
  ahead(s);
  git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'main only');
  const clean = run(s, 'review', { request: '--base ahead' });
  assert.equal(clean.stdout, NOTHING('ahead'));
  assert.equal(clean.status, 1);
  writeFileSync(join(s.repo, '.gitignore'), 'changed\n');
  const r = run(s, 'review', { request: '--base ahead' });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(calls(s), [[...REVIEW, '--base', 'ahead']]);
}));

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

test('review --uncommitted from a subdirectory runs from the top and sees a change in a sibling directory', spawning, withScratch((s) => {
  const r = run(s, 'review', { request: '', cwd: siblings(s) });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(calls(s), [[...REVIEW, '--uncommitted']]);
  assert.deepEqual(cwds(s), [s.repo]);
  assert.deepEqual(r.stdout.split('\n').slice(1, 3),
    [`cwd: ${s.repo}`, 'network: none in the read-only sandbox; Codex cannot fetch issues, pull requests or pages']);
}));

test('review --base from a subdirectory compares the whole repository: refused clean, proceeds on a sibling change', spawning, withScratch((s) => {
  const sub = siblings(s);
  git(s.repo, 'commit', '-q', '-am', 'sibling change');
  git(s.repo, 'branch', 'same');
  const clean = run(s, 'review', { request: '--base same', cwd: sub });
  assert.equal(clean.stdout, NOTHING('same'));
  assert.equal(clean.status, 1);
  writeFileSync(join(s.repo, 'b', 'file.txt'), 'changed again\n');
  const r = run(s, 'review', { request: '--base same', cwd: sub });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(calls(s), [[...REVIEW, '--base', 'same']]);
  assert.deepEqual(cwds(s), [s.repo]);
}));

test('review --cwd reviews that repository from its top, whatever directory the shell is in, with --cwd=<path> accepted too', spawning, withScratch((s) => {
  const sub = siblings(s);
  for (const line of [`--cwd ${sub}`, `--cwd=${sub}`]) {
    const r = run(s, 'review', { request: `--model m\n${line}\n`, cwd: s.plain });
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.stdout.split('\n')[1], `cwd: ${s.repo}`);
  }
  assert.deepEqual(calls(s), [[...REVIEW, '--uncommitted', '--model', 'm'], [...REVIEW, '--uncommitted', '--model', 'm']]);
  assert.deepEqual(cwds(s), [s.repo, s.repo]);
}));

test('review --cwd that is relative, not in a git repository, not last or given twice is refused with Codex never started', spawning, withScratch((s) => {
  const last = /^codex-lite: review arguments refused: --cwd must be the last line; refused\n/;
  const cases = [['--cwd rel/dir', /^codex-lite: review arguments refused: --cwd "rel\/dir" is empty or not an absolute path; refused\n/],
    [`--cwd ${s.plain}`, /^codex-lite: not inside a git repository, so nothing was run \(/],
    [`--cwd ${s.repo}\n--base main`, last],
    [`--cwd ${s.repo}\n--cwd ${s.repo}`, last]];
  for (const [request, message] of cases) {
    const r = run(s, 'review', { request });
    assert.match(r.stdout, message, request);
    assert.match(r.stdout, /\nstatus: refused\n$/, request);
  }
  assert.deepEqual(calls(s), []);
}));

test('ask from a subdirectory runs from the top of the repository', spawning, withScratch((s) => {
  const r = run(s, 'ask', { request: 'q', cwd: siblings(s) });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(cwds(s), [s.repo]);
  assert.equal(r.stdout.split('\n')[1], `cwd: ${s.repo}`);
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
    `HEAD ${before} before, ${after} after\nworking tree after the run:\n   M tracked.txt\n  !! .env\nthread ${THREAD}\n${RESUME}\nstatus: ok\n`);
  assert.equal(r.status, 0);
  assert.deepEqual(probeLeftovers(s), [false, []]);
}));

test('do from a subdirectory names it as cwd, probes under it, and lists the whole repository from its top', spawning, withScratch((s) => {
  const sub = siblings(s);
  const before = git(s.repo, 'rev-parse', '--short', 'HEAD').trim();
  const r = run(s, 'do', { request: 'go', cwd: sub, env: { FAKE_CODEX: 'commits' } });
  const after = git(s.repo, 'rev-parse', '--short', 'HEAD').trim();
  assert.equal(calls(s)[0].at(-1).startsWith(`${s.repo}/a/.codex-lite-probe-`), true);
  assert.deepEqual(cwds(s), [sub, sub, sub]);
  assert.notEqual(before, after);
  assert.equal(r.stdout, 'requested: codex exec --json --ignore-user-config -c approval_policy="never" -c sandbox_mode="workspace-write" -\n' +
    `cwd: ${s.repo}/a\nsandbox: workspace-write proven on this host before the run; the system temp directory stays writable\n\nfake answer\n\n` +
    `HEAD ${before} before, ${after} after\nworking tree after the run:\n   M b/file.txt\n  !! a/.env\nthread ${THREAD}\n${RESUME}\nstatus: ok\n`);
  assert.equal(r.status, 0);
}));

test('implement prints the do footer lines, passes --model, and sends only the task', spawning, withScratch((s) => {
  const before = git(s.repo, 'rev-parse', '--short', 'HEAD').trim();
  const r = run(s, 'implement', { request: '--model gpt-x\nfix it', env: { FAKE_CODEX: 'commits' } });
  const after = git(s.repo, 'rev-parse', '--short', 'HEAD').trim();
  assert.equal(calls(s).length, 3);
  assert.deepEqual(calls(s)[2], ['exec', '--json', '--ignore-user-config', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"',
    '--model', 'gpt-x', '-']);
  assert.equal(stdin(s), 'fix it');
  assert.equal(r.stdout, 'requested: codex exec --json --ignore-user-config -c approval_policy="never" -c sandbox_mode="workspace-write" --model gpt-x -\n' +
    `cwd: ${s.repo}\nsandbox: workspace-write proven on this host before the run; the system temp directory stays writable\n\nfake answer\n\n` +
    `HEAD ${before} before, ${after} after\nworking tree after the run:\n  !! .env\nthread ${THREAD}\n${RESUME}\nstatus: ok\n`);
  assert.equal(r.status, 0);
  assert.deepEqual(probeLeftovers(s), [false, []]);
}));

test('implement --cwd to a subdirectory sets cwd and the probe there, and lists the whole repository from its top', spawning, withScratch((s) => {
  const sub = siblings(s);
  const before = git(s.repo, 'rev-parse', '--short', 'HEAD').trim();
  const r = run(s, 'implement', { request: `--cwd ${sub}\ngo`, cwd: s.plain, env: { FAKE_CODEX: 'commits' } });
  const after = git(s.repo, 'rev-parse', '--short', 'HEAD').trim();
  assert.equal(calls(s)[0].at(-1).startsWith(`${s.repo}/a/.codex-lite-probe-`), true);
  assert.deepEqual(cwds(s), [sub, sub, sub]);
  assert.equal(r.stdout, 'requested: codex exec --json --ignore-user-config -c approval_policy="never" -c sandbox_mode="workspace-write" -\n' +
    `cwd: ${s.repo}/a\nsandbox: workspace-write proven on this host before the run; the system temp directory stays writable\n\nfake answer\n\n` +
    `HEAD ${before} before, ${after} after\nworking tree after the run:\n   M b/file.txt\n  !! a/.env\nthread ${THREAD}\n${RESUME}\nstatus: ok\n`);
  assert.equal(r.status, 0);
}));

test('implement --cwd naming a file or a missing path is refused with Codex never started', spawning, withScratch((s) => {
  for (const path of [join(s.repo, 'tracked.txt'), join(s.root, 'missing')]) {
    const r = run(s, 'implement', { request: `--cwd ${path}\ngo` });
    assert.match(r.stdout, /^codex-lite: not inside a git repository, so nothing was run \(/, path);
    assert.match(r.stdout, /\nstatus: refused\n$/, path);
  }
  assert.deepEqual(calls(s), []);
}));

test('do: a good run whose tree footer cannot be read ends with status: failed', spawning, withScratch((s) => {
  // Only the footer's git status passes --ignored; every other git call reaches the real git.
  const env = shims(s, `case "$*" in *--ignored*) echo 'fatal: footer broken' >&2; exit 1;; esac\n`);
  const r = run(s, 'do', { request: 'go', env });
  assert.equal(calls(s).at(-1)[0], 'exec');
  assert.match(r.stdout, /\n\nfake answer\n\ncodex-lite: git status after the run failed: fatal: footer broken\nthread \S+\nResume: .*\nstatus: failed\n$/);
  assert.equal(r.status, 1);
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
