import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildArgv, readStream, decideProbe, validateRequestId, requestedLine, resumeLine, parseAskArgs, parseImplementArgs, parseReviewArgs, PROBE_SCRIPT, windowsSandboxSetting,
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

test('ask, with a model before the stdin marker', () => {
  assert.deepEqual(buildArgv('ask', { model: 'gpt-5' }), ['exec', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '--model', 'gpt-5', '-']);
});

test('ask, resuming a thread: exec resume <id>, always read-only', () => {
  assert.deepEqual(buildArgv('ask', { resume: 't-9' }), ['exec', 'resume', 't-9', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '-']);
});

test('ask, resuming a thread, with a model', () => {
  assert.deepEqual(buildArgv('ask', { resume: 't-9', model: 'gpt-5' }), ['exec', 'resume', 't-9', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '--model', 'gpt-5', '-']);
});

test('ask, resuming a thread, with a Windows sandbox mode', () => {
  assert.deepEqual(buildArgv('ask', { resume: 't-9', windowsSandbox: 'elevated' }), ['exec', 'resume', 't-9', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '-c', 'windows.sandbox="elevated"', '-']);
});

test('buildArgv refuses a resume id starting with "-", even though it matches the character class', () => {
  assert.throws(() => buildArgv('ask', { resume: '-x' }), /--resume id "-x" is malformed; refused$/);
});

test('buildArgv treats a bare resume (true) as malformed: the entry script must resolve it first', () => {
  assert.throws(() => buildArgv('ask', { resume: true }), /--resume id true is malformed; refused$/);
});

test('do', () => {
  assert.deepEqual(buildArgv('do'), ['exec', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"', '-']);
});

test('implement is the do argv, plus --model when given', () => {
  assert.deepEqual(buildArgv('implement'), ['exec', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"', '-']);
  assert.deepEqual(buildArgv('implement', { model: 'gpt-x' }), ['exec', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"', '--model', 'gpt-x', '-']);
  assert.deepEqual(buildArgv('implement', { model: 'gpt-x', windowsSandbox: 'elevated' }), ['exec', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"', '-c', 'windows.sandbox="elevated"', '--model', 'gpt-x', '-']);
  assert.throws(() => buildArgv('implement', { model: '-x' }), /--model "-x" is empty or starts with "-"; refused$/);
});

test('a Windows sandbox mode is passed on every sandboxed call', () => {
  const win = ['-c', 'windows.sandbox="unelevated"'];
  assert.deepEqual(buildArgv('review', { windowsSandbox: 'unelevated' }), ['exec', 'review', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', ...win, '--uncommitted']);
  assert.deepEqual(buildArgv('do', { windowsSandbox: 'unelevated' }), ['exec', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"', ...win, '-']);
  assert.deepEqual(buildArgv('sandbox', { execPath: 'C:\node.exe', target: 'C:\p', windowsSandbox: 'unelevated' }), [
    'sandbox', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', ...win, '--', 'C:\node.exe', '-e', ONE_LINER, 'C:\p']);
});

test('buildArgv refuses a Windows sandbox mode other than unelevated or elevated', () => {
  assert.throws(() => buildArgv('ask', { windowsSandbox: 'none' }), /unexpected -c override/);
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
  assert.equal(resumeLine('--last'), null);
});

test('resume line runs as pasted into a POSIX shell', { skip: process.platform === 'win32' && 'no POSIX shell' }, () => {
  const out = spawnSync('sh', ['-c', `set -- ${resumeLine('t-9')}; printf '%s\\n' "$@"`], { encoding: 'utf8' });
  assert.deepEqual(out.stdout.split('\n').slice(0, -1), ['codex', 'exec', 'resume', 't-9', '--json', '--ignore-user-config',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', 'your follow-up here']);
});

test('resume line carries the Windows sandbox mode when there is one', () => {
  assert.equal(resumeLine('t-9', 'elevated'), 'codex exec resume t-9 --json --ignore-user-config ' +
    '-c \'approval_policy="never"\' -c \'sandbox_mode="read-only"\' -c \'windows.sandbox="elevated"\' \'your follow-up here\'');
});

test('windowsSandboxSetting reads windows.sandbox and nothing else', () => {
  assert.equal(windowsSandboxSetting('model = "x"\r\n\r\n[windows]\r\nsandbox = "elevated" # admin\r\n\r\n[tui]\r\n'), 'elevated');
  assert.equal(windowsSandboxSetting("[ windows ]\nsandbox='unelevated'\n"), 'unelevated');
  assert.equal(windowsSandboxSetting('sandbox = "elevated"\n[other]\nsandbox = "elevated"\n[windows]\n# sandbox = "elevated"\n'), undefined);
  assert.equal(windowsSandboxSetting(''), undefined);
});

test('windowsSandboxSetting reads the dotted, inline and quoted forms', () => {
  assert.equal(windowsSandboxSetting('windows.sandbox = "elevated"\n'), 'elevated');
  assert.equal(windowsSandboxSetting('windows = { other = 1, sandbox = "unelevated" }\n'), 'unelevated');
  assert.equal(windowsSandboxSetting('["windows"]\n"sandbox" = "elevated"\n'), 'elevated');
  assert.equal(windowsSandboxSetting("'windows'.sandbox = 'elevated'\n"), 'elevated');
  assert.equal(windowsSandboxSetting("'windows' = { sandbox = 'elevated' }\n"), 'elevated');
  assert.equal(windowsSandboxSetting('[tui]\nwindows.sandbox = "elevated"\n'), undefined);
});

test('windowsSandboxSetting reads an inline table by its structure, not by the text inside its strings', () => {
  assert.equal(windowsSandboxSetting('windows = { note = "}", sandbox = "elevated" }\n'), 'elevated');
  assert.equal(windowsSandboxSetting('windows = { a = { b = 1 }, sandbox = "elevated" }\n'), 'elevated');
  assert.equal(windowsSandboxSetting('windows = { note = "a, sandbox = \'elevated\', b" }\n'), undefined);
});

test('windowsSandboxSetting skips multiline strings', () => {
  for (const q of ["'''", '"""']) {
    assert.equal(windowsSandboxSetting(`notes = ${q}\n[windows]\nsandbox = "unelevated"\n${q}\n[windows]\nsandbox = "elevated"\n`), 'elevated');
  }
  assert.equal(windowsSandboxSetting('one = """x"""\n[windows]\nsandbox = "elevated"\n'), 'elevated');
});

test('windowsSandboxSetting ignores delimiters inside comments and one-line strings, and # inside a value', () => {
  assert.equal(windowsSandboxSetting('# see """ docs\n[windows] # admin\nsandbox = "elevated"\n'), 'elevated');
  assert.equal(windowsSandboxSetting('x = "has \'\'\' and \\" in it"\n[windows]\nsandbox = "elevated"\n'), 'elevated');
  assert.equal(windowsSandboxSetting('[windows]\nsandbox = "x#y"\n'), 'x#y');
});

test('review arguments: empty means the working tree', () => {
  assert.deepEqual(parseReviewArgs('\n'), { base: undefined, model: undefined, timeout: undefined });
});

test('review arguments: --base and --model split on whitespace', () => {
  assert.deepEqual(parseReviewArgs('--base topic/$(id)\n  --model gpt-5\n'), { base: 'topic/$(id)', model: 'gpt-5', timeout: undefined });
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

test('review arguments: --cwd is the last line, as --cwd <path> or --cwd=<path>', () => {
  assert.deepEqual(parseReviewArgs('--base main\n--model x\n--cwd /tmp/a b\\c  \t\n\n'), { base: 'main', model: 'x', timeout: undefined, cwd: '/tmp/a b\\c' });
  assert.deepEqual(parseReviewArgs('--cwd=/tmp/a'), { base: undefined, model: undefined, timeout: undefined, cwd: '/tmp/a' });
  assert.deepEqual(parseReviewArgs('--timeout 5\r\n--cwd /tmp/a\r\n'), { base: undefined, model: undefined, timeout: 5, cwd: '/tmp/a' });
});

test('review arguments: a relative or empty --cwd is refused', () => {
  assert.throws(() => parseReviewArgs('--cwd rel/dir'), /--cwd "rel\/dir" is empty or not an absolute path; refused$/);
  assert.throws(() => parseReviewArgs('--base main\n--cwd'), /--cwd "" is empty or not an absolute path; refused$/);
});

test('review arguments: a --cwd that is not the last line, or is given twice, is refused', () => {
  for (const text of ['--cwd /tmp/a\n--base main', '--cwd /tmp/a\n--cwd /tmp/b', '--cwd=/tmp/a\n--timeout 5\n--cwd=/tmp/b', '  --cwd /tmp/a\n--model x\n',
    '--base main --cwd /tmp/a', '--model x --cwd=/tmp/a --base main', '--cwd\vC:\\a']) {
    assert.throws(() => parseReviewArgs(text), /^Error: --cwd must be the last line; refused$/, text);
  }
});

test('ask arguments: a plain question is the whole text', () => {
  assert.deepEqual(parseAskArgs('what does math.mjs export?\n'), { model: undefined, resume: undefined, timeout: undefined, question: 'what does math.mjs export?\n' });
});

test('ask arguments: a leading --model <name> is split from the question', () => {
  assert.deepEqual(parseAskArgs('--model gpt-5 critique this plan:\n  1. step'),
    { model: 'gpt-5', resume: undefined, timeout: undefined, question: 'critique this plan:\n  1. step' });
});

test('ask arguments: a leading --model=<name> is split from the question', () => {
  assert.deepEqual(parseAskArgs('--model=astra\nwhy?'), { model: 'astra', resume: undefined, timeout: undefined, question: 'why?' });
});

test('ask arguments: a --model later in the question is question text', () => {
  assert.deepEqual(parseAskArgs('what does --model gpt-5 do?'), { model: undefined, resume: undefined, timeout: undefined, question: 'what does --model gpt-5 do?' });
});

// --resume forms, exactly as the interface contract lists them.
test('ask arguments: --resume then a newline is bare; the question starts on the next line', () => {
  assert.deepEqual(parseAskArgs('--resume\nq'), { model: undefined, resume: true, timeout: undefined, question: 'q' });
});

test('ask arguments: bare --resume consumes only the one newline after it', () => {
  assert.deepEqual(parseAskArgs('--resume\n\nq'), { model: undefined, resume: true, timeout: undefined, question: '\nq' });
});

test('ask arguments: trailing whitespace before the newline still leaves --resume bare', () => {
  assert.deepEqual(parseAskArgs('--resume \nq'), { model: undefined, resume: true, timeout: undefined, question: 'q' });
});

test('ask arguments: a CRLF line ending after bare --resume is consumed whole', () => {
  assert.deepEqual(parseAskArgs('--resume\r\nq'), { model: undefined, resume: true, timeout: undefined, question: 'q' });
});

test('ask arguments: trailing whitespace with nothing after it is still bare', () => {
  assert.deepEqual(parseAskArgs('--resume '), { model: undefined, resume: true, timeout: undefined, question: '' });
});

test('ask arguments: --resume <id> on the same line is an explicit id', () => {
  assert.deepEqual(parseAskArgs('--resume t-9 q'), { model: undefined, resume: 't-9', timeout: undefined, question: 'q' });
});

test('ask arguments: extra spaces before the id are skipped, not read as part of it', () => {
  assert.deepEqual(parseAskArgs('--resume  t-9 q'), { model: undefined, resume: 't-9', timeout: undefined, question: 'q' });
});

test('ask arguments: --resume=<id> is the same as the space form', () => {
  assert.deepEqual(parseAskArgs('--resume=t-9 q'), { model: undefined, resume: 't-9', timeout: undefined, question: 'q' });
});

test('ask arguments: a plain word after --resume is taken as the id, not as question text', () => {
  assert.deepEqual(parseAskArgs('--resume what about step 3?'), { model: undefined, resume: 'what', timeout: undefined, question: 'about step 3?' });
});

test('ask arguments: --resume directly before --model is bare', () => {
  assert.deepEqual(parseAskArgs('--resume --model x q'), { model: 'x', resume: true, timeout: undefined, question: 'q' });
});

test('ask arguments: --model then --resume, in that order, both take effect', () => {
  assert.deepEqual(parseAskArgs('--model x --resume\nq'), { model: 'x', resume: true, timeout: undefined, question: 'q' });
});

test('ask arguments: extra spaces or lines between the options do not turn the second into question text', () => {
  assert.deepEqual(parseAskArgs('--model gpt-5  --resume\nfollow up'), { model: 'gpt-5', resume: true, timeout: undefined, question: 'follow up' });
  assert.deepEqual(parseAskArgs('--resume\n  --model x\nq'), { model: 'x', resume: true, timeout: undefined, question: 'q' });
});

test('ask arguments: --resume alone, with nothing after it, is bare with an empty question', () => {
  assert.deepEqual(parseAskArgs('--resume'), { model: undefined, resume: true, timeout: undefined, question: '' });
});

test('ask arguments: --resume later in the question is question text', () => {
  assert.deepEqual(parseAskArgs('what does --resume do?'), { model: undefined, resume: undefined, timeout: undefined, question: 'what does --resume do?' });
});

test('ask arguments: a token that only starts with an option name is an id after --resume, and refused', () => {
  assert.throws(() => parseAskArgs('--resume --modeler what?'), /--resume id "--modeler" is malformed; refused$/);
});

test('ask arguments: a malformed --resume id is refused before it becomes a question', () => {
  assert.throws(() => parseAskArgs('--resume bad;id q'), /--resume id "bad;id" is malformed; refused$/);
});

test('ask arguments: a --resume id starting with "-" is refused, even though it matches the character class', () => {
  assert.throws(() => parseAskArgs('--resume -x q'), /--resume id "-x" is malformed; refused$/);
});

test('ask arguments: --resume= with no id is refused', () => {
  assert.throws(() => parseAskArgs('--resume='), /--resume id "" is malformed; refused$/);
});

test('ask arguments: --resume=<malformed id> is refused the same way as the space form', () => {
  assert.throws(() => parseAskArgs('--resume=bad;id q'), /--resume id "bad;id" is malformed; refused$/);
});

test('ask arguments: --resume given more than once is refused', () => {
  assert.throws(() => parseAskArgs('--resume t-1 --resume t-2 q'), /--resume given more than once; refused$/);
});

test('ask arguments: --model given more than once is refused', () => {
  assert.throws(() => parseAskArgs('--model a --model b q'), /--model given more than once; refused$/);
});

test('ask arguments: a missing or empty model name is refused', () => {
  for (const text of ['--model', '--model  \n', '--model=', '--model= why?']) {
    assert.throws(() => parseAskArgs(text), /--model "" is empty or starts with "-"; refused/, text);
  }
});

test('ask arguments: a model name starting with a hyphen is refused', () => {
  assert.throws(() => parseAskArgs('--model --output=x why?'), /--model "--output=x" is empty or starts with "-"; refused/);
});

// --timeout <seconds>, for ask and review: a whole number from 1 to 3600, at most once.
test('ask arguments: --timeout <seconds> and --timeout=<seconds> are split from the question as a number', () => {
  assert.deepEqual(parseAskArgs('--timeout 5 q'), { model: undefined, resume: undefined, timeout: 5, question: 'q' });
  assert.deepEqual(parseAskArgs('--timeout=5\nq'), { model: undefined, resume: undefined, timeout: 5, question: 'q' });
});

test('ask arguments: --timeout accepts the boundaries 1 and 3600', () => {
  assert.deepEqual(parseAskArgs('--timeout 1 q'), { model: undefined, resume: undefined, timeout: 1, question: 'q' });
  assert.deepEqual(parseAskArgs('--timeout 3600 q'), { model: undefined, resume: undefined, timeout: 3600, question: 'q' });
});

test('ask arguments: a --timeout outside 1 to 3600, or not a whole number, is refused naming the value', () => {
  for (const [text, value] of [['--timeout 0 q', '"0"'], ['--timeout 3601 q', '"3601"'], ['--timeout x q', '"x"'], ['--timeout 2.5 q', '"2.5"'],
    ['--timeout -5 q', '"-5"'], ['--timeout', '""'], ['--timeout= q', '""'], ['--timeout=', '""']]) {
    assert.throws(() => parseAskArgs(text), new RegExp(`^Error: --timeout ${value} is not a whole number of seconds from 1 to 3600; refused$`), text);
  }
});

test('ask arguments: --timeout given more than once is refused', () => {
  assert.throws(() => parseAskArgs('--timeout 5 --timeout=6 q'), /^Error: --timeout given more than once; refused$/);
});

test('ask arguments: --timeout with --model and --resume, in each order, all take effect', () => {
  const want = { model: 'x', resume: 't-9', timeout: 5, question: 'q' };
  for (const text of ['--timeout 5 --model x --resume t-9 q', '--timeout 5 --resume t-9 --model x q', '--model x --timeout 5 --resume t-9 q',
    '--model x --resume t-9 --timeout 5 q', '--resume t-9 --timeout 5 --model x q', '--resume t-9 --model x --timeout 5 q']) {
    assert.deepEqual(parseAskArgs(text), want, text);
  }
});

test('ask arguments: --resume directly before --timeout on one line is bare', () => {
  assert.deepEqual(parseAskArgs('--resume --timeout 5 q'), { model: undefined, resume: true, timeout: 5, question: 'q' });
  assert.deepEqual(parseAskArgs('--timeout 5 --resume\nq'), { model: undefined, resume: true, timeout: 5, question: 'q' });
});

test('ask arguments: --timeout later in the question is question text', () => {
  assert.deepEqual(parseAskArgs('what does --timeout 5 do?'), { model: undefined, resume: undefined, timeout: undefined, question: 'what does --timeout 5 do?' });
});

test('review arguments: --timeout <seconds> and --timeout=<seconds>, with the boundaries 1 and 3600', () => {
  assert.deepEqual(parseReviewArgs('--timeout 5'), { base: undefined, model: undefined, timeout: 5 });
  assert.deepEqual(parseReviewArgs('--base main --timeout=5 --model x\n'), { base: 'main', model: 'x', timeout: 5 });
  assert.deepEqual(parseReviewArgs('--timeout 1'), { base: undefined, model: undefined, timeout: 1 });
  assert.deepEqual(parseReviewArgs('--timeout 3600'), { base: undefined, model: undefined, timeout: 3600 });
});

test('review arguments: a --timeout outside 1 to 3600, or not a whole number, is refused naming the value', () => {
  for (const [text, value] of [['--timeout 0', '"0"'], ['--timeout 3601', '"3601"'], ['--timeout x', '"x"'], ['--timeout 2.5', '"2.5"'],
    ['--timeout=-5', '"-5"'], ['--timeout=', '""']]) {
    assert.throws(() => parseReviewArgs(text), new RegExp(`^Error: --timeout ${value} is not a whole number of seconds from 1 to 3600; refused$`), text);
  }
});

test('review arguments: a --timeout with no value, or a value starting with a hyphen after a space, is refused by the option parser', () => {
  assert.throws(() => parseReviewArgs('--timeout'), /Option '--timeout <value>' argument missing$/);
  assert.throws(() => parseReviewArgs('--timeout -5'), /Option '--timeout' argument is ambiguous\./);
});

test('review arguments: --base or --model given more than once is refused, in either spelling', () => {
  assert.throws(() => parseReviewArgs('--base main --base dev'), /^Error: --base given more than once; refused$/);
  assert.throws(() => parseReviewArgs('--model=x --model y'), /^Error: --model given more than once; refused$/);
});

test('ask arguments: a CRLF line ending after --model or --timeout is consumed whole', () => {
  assert.deepEqual(parseAskArgs('--model x\r\nq'), { model: 'x', resume: undefined, timeout: undefined, question: 'q' });
  assert.deepEqual(parseAskArgs('--timeout 5\r\nq'), { model: undefined, resume: undefined, timeout: 5, question: 'q' });
  assert.deepEqual(parseAskArgs('--timeout=5\r\n\nq'), { model: undefined, resume: undefined, timeout: 5, question: '\nq' });
});

test('review arguments: --timeout given more than once is refused, in either spelling', () => {
  for (const text of ['--timeout 5 --timeout 6', '--timeout=5 --timeout 6', '--timeout 5 --timeout=5']) {
    assert.throws(() => parseReviewArgs(text), /^Error: --timeout given more than once; refused$/, text);
  }
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

const NONE = { model: undefined, timeout: undefined, cwd: undefined };

test('implement arguments: no options leaves the whole text as the task', () => {
  assert.deepEqual(parseImplementArgs('add a test\n'), { ...NONE, task: 'add a test\n' });
});

test('implement arguments: each option alone, with the task after it', () => {
  assert.deepEqual(parseImplementArgs('--model gpt-x\ngo'), { ...NONE, model: 'gpt-x', task: 'go' });
  assert.deepEqual(parseImplementArgs('--model=gpt-x go'), { ...NONE, model: 'gpt-x', task: 'go' });
  assert.deepEqual(parseImplementArgs('--timeout 90\ngo'), { ...NONE, timeout: 90, task: 'go' });
  assert.deepEqual(parseImplementArgs('--cwd /tmp/a\ngo'), { ...NONE, cwd: '/tmp/a', task: 'go' });
  assert.deepEqual(parseImplementArgs('--cwd=/tmp/a\r\ngo'), { ...NONE, cwd: '/tmp/a', task: 'go' });
});

test('implement arguments: --model and --timeout in either order, then --cwd last', () => {
  assert.deepEqual(parseImplementArgs('--model m --timeout 5\n--cwd /tmp/a\ngo'), { model: 'm', timeout: 5, cwd: '/tmp/a', task: 'go' });
  assert.deepEqual(parseImplementArgs('--timeout 5 --model m\n\n--cwd /tmp/a\ngo'), { model: 'm', timeout: 5, cwd: '/tmp/a', task: 'go' });
});

test('implement arguments: each option given twice is refused', () => {
  assert.throws(() => parseImplementArgs('--model a --model b\ngo'), /--model given more than once; refused$/);
  assert.throws(() => parseImplementArgs('--timeout 1 --timeout 2\ngo'), /--timeout given more than once; refused$/);
  assert.throws(() => parseImplementArgs('--cwd /tmp/a\n--cwd /tmp/b\ngo'), /--cwd given more than once; refused$/);
});

test('implement arguments: --model or --timeout after --cwd is refused', () => {
  assert.throws(() => parseImplementArgs('--cwd /tmp/a\n--model m\ngo'), /--cwd must be the last option; refused$/);
  assert.throws(() => parseImplementArgs('--cwd /tmp/a\n--timeout 5\ngo'), /--cwd must be the last option; refused$/);
});

test('implement arguments: a relative or empty --cwd is refused', () => {
  assert.throws(() => parseImplementArgs('--cwd rel/dir\ngo'), /--cwd "rel\/dir" is empty or not an absolute path; refused$/);
  assert.throws(() => parseImplementArgs('--cwd\ngo'), /--cwd "" is empty or not an absolute path; refused$/);
  assert.throws(() => parseImplementArgs('--cwd=\ngo'), /--cwd "" is empty or not an absolute path; refused$/);
});

test('implement arguments: a --cwd with spaces or backslashes is kept, trailing spaces and tabs dropped', () => {
  assert.deepEqual(parseImplementArgs('--cwd /tmp/a b\ngo'), { ...NONE, cwd: '/tmp/a b', task: 'go' });
  assert.deepEqual(parseImplementArgs('--cwd /tmp/x\\y\r\ngo'), { ...NONE, cwd: '/tmp/x\\y', task: 'go' });
  assert.deepEqual(parseImplementArgs('--cwd=/tmp/a b \ngo'), { ...NONE, cwd: '/tmp/a b', task: 'go' });
  assert.deepEqual(parseImplementArgs('--cwd /tmp/a \t\r\ngo'), { ...NONE, cwd: '/tmp/a', task: 'go' });
});

test('implement arguments: --resume is task text, and --cwd with no task leaves an empty task', () => {
  assert.deepEqual(parseImplementArgs('--resume t-1\ngo'), { ...NONE, task: '--resume t-1\ngo' });
  assert.deepEqual(parseImplementArgs('--model m\n--resume\ngo'), { ...NONE, model: 'm', task: '--resume\ngo' });
  assert.deepEqual(parseImplementArgs('--cwd /tmp/a'), { ...NONE, cwd: '/tmp/a', task: '' });
});
