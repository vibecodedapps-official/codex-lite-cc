import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildArgv, readStream, decideProbe, validateRequestId, requestedLine, resumeLine, parseReviewArgs, PROBE_SCRIPT,
} from '../plugins/codex-lite/scripts/codex.mjs';

const ONE_LINER = 'try{require("fs").writeFileSync(process.argv[1],"x");process.exit(0)}catch(e){' +
  'process.stderr.write(String(e&&e.code));process.exit(e&&(e.code==="EPERM"||e.code==="EACCES")?42:9)}';

test('review, working tree', () => {
  assert.deepEqual(buildArgv('review', {}), ['exec', 'review', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '--uncommitted']);
});

test('review, working tree, with a model', () => {
  assert.deepEqual(buildArgv('review', { model: 'gpt-5' }), ['exec', 'review', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '--uncommitted', '--model', 'gpt-5']);
});

test('review, branch: a ref with shell syntax stays one element', () => {
  assert.deepEqual(buildArgv('review', { base: 'topic/$(id)' }), ['exec', 'review', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '--base', 'topic/$(id)']);
});

test('review, branch, with a model', () => {
  assert.deepEqual(buildArgv('review', { base: 'main', model: 'gpt-5' }), ['exec', 'review', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '--base', 'main', '--model', 'gpt-5']);
});

test('ask', () => {
  assert.deepEqual(buildArgv('ask'), ['exec', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '-']);
});

test('do', () => {
  assert.deepEqual(buildArgv('do'), ['exec', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"', '-']);
});

test('setup: version', () => {
  assert.deepEqual(buildArgv('version'), ['--version']);
});

test('setup: login status', () => {
  assert.deepEqual(buildArgv('login'), ['login', 'status']);
});

test('sandbox probe, positive control', () => {
  assert.deepEqual(buildArgv('sandbox', { execPath: '/opt/node/bin/node', target: '/repo/.codex-lite-probe-a1/probe' }), [
    'sandbox', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', '--',
    '/opt/node/bin/node', '-e', ONE_LINER, '/repo/.codex-lite-probe-a1/probe']);
});

test('sandbox probe, negative control', () => {
  assert.deepEqual(buildArgv('sandbox', { execPath: '/opt/node/bin/node', target: '/home/u/.codex-lite-sandbox-probe' }), [
    'sandbox', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', '--',
    '/opt/node/bin/node', '-e', ONE_LINER, '/home/u/.codex-lite-sandbox-probe']);
});

test('buildArgv refuses a review value that would read as an option', () => {
  assert.throws(() => buildArgv('review', { base: '--output=x' }), /--base "--output=x" is empty or starts with "-"/);
  assert.throws(() => buildArgv('review', { model: '-s' }), /--model "-s"/);
});

test('buildArgv refuses an unknown command', () => {
  assert.throws(() => buildArgv('exec'), /unknown command "exec"/);
});

test('requested line is the argv joined with spaces', () => {
  assert.equal(requestedLine(buildArgv('ask')),
    'requested: codex exec --json --ignore-user-config -c approval_policy="never" -c sandbox_mode="read-only" -');
});

const stream = (...chunks) => {
  const reader = readStream();
  for (const c of chunks) reader.write(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return reader.end();
};

test('a reasoning item after the last agent_message is not the answer', () => {
  assert.deepEqual(stream(
    '{"type":"thread.started","thread_id":"01a0cc8a-da9f-7343-99f7-579b98b8ff02"}\n',
    '{"type":"turn.started"}\n',
    '{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"ls","exit_code":null,"status":"in_progress"}}\n',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}\n',
    '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Executing shell commands**"}}\n',
    '{"type":"turn.completed","usage":{"input_tokens":16469,"output_tokens":5}}\n',
  ), { threadId: '01a0cc8a-da9f-7343-99f7-579b98b8ff02', finalMessage: 'ok', unparseableLines: 0, sawTurnCompleted: true, errors: [] });
});

test('an item.completed with an unknown item type is ignored', () => {
  assert.equal(stream(
    '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}\n',
    '{"type":"item.completed","item":{"type":"web_search","text":"not the answer"}}\n',
  ).finalMessage, 'answer');
});

test('an unknown top-level event is ignored even when it carries an agent_message item', () => {
  assert.deepEqual(stream(
    '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}\n',
    '{"type":"item.updated","item":{"type":"agent_message","text":"not the answer"}}\n',
    '{"type":"turn.completed"}\n',
  ), { threadId: null, finalMessage: 'answer', unparseableLines: 0, sawTurnCompleted: true, errors: [] });
});

test('a multi-byte character split across two Buffers survives', () => {
  const bytes = Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"café \u{1F600}"}}\n');
  const cut = bytes.indexOf(0xf0) + 2;
  assert.equal(stream(bytes.subarray(0, cut), bytes.subarray(cut)).finalMessage, 'café \u{1F600}');
});

test('a stream with no command event at all yields the last message and a completed turn', () => {
  assert.deepEqual(stream(
    '{"type":"thread.started","thread_id":"t-1"}\n{"type":"turn.started"}\n',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I\'ll run the command exactly as provided."}}\n',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"```text\\nzsh:1: operation not permitted: ./refused2.txt\\n```"}}\n',
    '{"type":"turn.completed","usage":{}}\n',
  ), { threadId: 't-1', finalMessage: '```text\nzsh:1: operation not permitted: ./refused2.txt\n```', unparseableLines: 0, sawTurnCompleted: true, errors: [] });
});

test('no turn.completed leaves sawTurnCompleted false', () => {
  assert.equal(stream('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n').sawTurnCompleted, false);
});

test('turn.completed with no message leaves finalMessage null', () => {
  assert.deepEqual(stream('{"type":"thread.started","thread_id":"t-2"}\n{"type":"turn.completed"}\n'),
    { threadId: 't-2', finalMessage: null, unparseableLines: 0, sawTurnCompleted: true, errors: [] });
});

test('unparseable lines are counted and a final line without a newline is still read', () => {
  assert.deepEqual(stream('warning: not json\n\n{"type":"turn.co', 'mpleted"}'),
    { threadId: null, finalMessage: null, unparseableLines: 1, sawTurnCompleted: true, errors: [] });
});

test('readStream refuses strings', () => {
  assert.throws(() => readStream().write('{"type":"turn.completed"}\n'), TypeError);
});

const ok = { ok: true };
const inside = { exit: 0, created: true };
const denied = { exit: 42, created: false, code: 'EPERM' };

test('decideProbe passes on reachable target, inside write landed, outside write denied', () => {
  assert.deepEqual(decideProbe({ reachability: ok, positive: inside, negative: denied }),
    { pass: true, reason: 'workspace-write proven: an inside write landed and an outside write was denied (EPERM)' });
});

const refuses = (observations, pattern) => {
  const { pass, reason } = decideProbe(observations);
  assert.equal(pass, false);
  assert.match(reason, pattern);
};

test('decideProbe refuses: negative control exit 1', () => {
  refuses({ reachability: ok, positive: inside, negative: { exit: 1, created: false } }, /^negative control failed: .* gave exit 1, file not created;/);
});

test('decideProbe refuses: negative control exit 0 with the file created', () => {
  refuses({ reachability: ok, positive: inside, negative: { exit: 0, created: true } }, /^negative control failed: .* gave exit 0, file created;/);
});

test('decideProbe refuses: negative control exit 9', () => {
  refuses({ reachability: ok, positive: inside, negative: { exit: 9, created: false, code: 'ENOENT' } },
    /^negative control failed: .* gave exit 9 \(ENOENT\), file not created;/);
});

test('decideProbe refuses: negative control exit 71', () => {
  refuses({ reachability: ok, positive: inside, negative: { exit: 71, created: false } }, /^negative control failed: .* gave exit 71, file not created;/);
});

test('decideProbe refuses: negative control exit 42 but the file was created', () => {
  refuses({ reachability: ok, positive: inside, negative: { exit: 42, created: true, code: 'EACCES' } },
    /^negative control failed: .* gave exit 42 \(EACCES\), file created;/);
});

test('decideProbe refuses: positive control exit 9', () => {
  refuses({ reachability: ok, positive: { exit: 9, created: false, code: 'ENOENT' }, negative: denied },
    /^positive control failed: .* gave exit 9 \(ENOENT\), file not created;/);
});

test('decideProbe refuses: positive control exit 0 without the file', () => {
  refuses({ reachability: ok, positive: { exit: 0, created: false }, negative: denied }, /^positive control failed: .* gave exit 0, file not created;/);
});

test('decideProbe refuses: reachability failing names the code and does not blame the host', () => {
  refuses({ reachability: { ok: false, code: 'EACCES' }, positive: inside, negative: denied },
    /^reachability check failed: .*\(EACCES\).*says nothing about whether the host can sandbox$/);
});

test('validateRequestId accepts a session UUID', () => {
  assert.equal(validateRequestId('01a0cc8d-ada9-7501-a8e1-f64ad8e79180'), true);
});

test('validateRequestId refuses command substitution, path separators, "..", and empty', () => {
  for (const bad of ['$(id)aaaaaaaa', 'abcdefgh/ijk', 'abcdefgh\\ijk', '..', '../../../etc', '']) assert.equal(validateRequestId(bad), false, bad);
});

test('resume line is read-only and absent without a thread id', () => {
  assert.equal(resumeLine('01a0cc8d-ada9-7501-a8e1-f64ad8e79180'),
    'codex exec resume 01a0cc8d-ada9-7501-a8e1-f64ad8e79180 --json --ignore-user-config ' +
    '-c \'approval_policy="never"\' -c \'sandbox_mode="read-only"\' \'your follow-up here\'');
  assert.equal(resumeLine(null), null);
  assert.equal(resumeLine("x'; id; '"), null);
});

test('resume line runs as pasted into a POSIX shell', { skip: process.platform === 'win32' && 'no POSIX shell' }, () => {
  const out = spawnSync('sh', ['-c', `set -- ${resumeLine('t-9')}; printf '%s\\n' "$@"`], { encoding: 'utf8' });
  assert.deepEqual(out.stdout.split('\n').slice(0, -1), ['codex', 'exec', 'resume', 't-9', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', 'your follow-up here']);
});

test('review arguments: empty means the working tree', () => {
  assert.deepEqual(parseReviewArgs('\n'), { base: undefined, model: undefined });
});

test('review arguments: --base and --model split on whitespace', () => {
  assert.deepEqual(parseReviewArgs('--base topic/$(id)\n  --model gpt-5\n'), { base: 'topic/$(id)', model: 'gpt-5' });
});

test('review arguments: a value starting with a hyphen is refused', () => {
  assert.throws(() => parseReviewArgs('--base=--output=x'), /--base "--output=x" is empty or starts with "-"; refused/);
});

test('review arguments: --uncommitted is refused', () => {
  assert.throws(() => parseReviewArgs('--uncommitted'), /'--uncommitted'/);
});

test('review arguments: an unknown option or a bare word is refused', () => {
  assert.throws(() => parseReviewArgs('--output x'), /'--output'/);
  assert.throws(() => parseReviewArgs('main'), /'main'/);
});

const probe = (target) => spawnSync(process.execPath, ['-e', PROBE_SCRIPT, target], { encoding: 'utf8' });

test('probe one-liner: 0 on a write that lands, 9 and the code otherwise', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-lite-pure-'));
  try {
    assert.equal(probe(join(dir, 'f')).status, 0);
    assert.equal(existsSync(join(dir, 'f')), true);
    const missing = probe(join(dir, 'no', 'f'));
    assert.deepEqual([missing.status, missing.stderr], [9, 'ENOENT']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('probe one-liner: 42 and the code on a denied write',
  { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs a POSIX non-root user' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-lite-pure-'));
    try {
      chmodSync(dir, 0o500);
      const denied = probe(join(dir, 'f'));
      assert.equal(denied.status, 42);
      assert.match(denied.stderr, /^(EACCES|EPERM)$/);
    } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
  });
