// Pure half: inputs to argv arrays, bytes to a result. No filesystem, spawn, clock or environment.
// Errors and refusal reasons here carry no "codex-lite:" prefix; the entry script adds it once.
import { StringDecoder } from 'node:string_decoder';
import { parseArgs } from 'node:util';

const turnPrefix = (mode) => ['--json', '--ignore-user-config', '-c', 'approval_policy="never"', '-c', `sandbox_mode="${mode}"`];
const FORBIDDEN = ['--color', '--ephemeral', '--sandbox', '-s', '--skip-git-repo-check', '--ignore-rules', '--full-auto',
  '--dangerously-bypass-approvals-and-sandbox'];
const ALLOWED_OVERRIDES = ['approval_policy="never"', 'sandbox_mode="read-only"', 'sandbox_mode="workspace-write"'];

// Run as `node -e PROBE_SCRIPT <target>`. Exits 0 when the write lands, 42 when it is denied (macOS says EPERM,
// Windows and Linux sandboxes say EACCES), 9 on anything else; the error code name goes to stderr.
export const PROBE_SCRIPT = 'try{require("fs").writeFileSync(process.argv[1],"x");process.exit(0)}catch(e){' +
  'process.stderr.write(String(e&&e.code));process.exit(e&&(e.code==="EPERM"||e.code==="EACCES")?42:9)}';

// A value starting with "-" would reach Codex or git as an option.
const plain = (name, v) => {
  if (typeof v !== 'string' || v === '' || v.startsWith('-')) throw new Error(`${name} ${JSON.stringify(v)} is empty or starts with "-"; refused`);
  return v;
};

export function buildArgv(command, options = {}) {
  let argv;
  if (command === 'review') {
    argv = ['exec', 'review', ...turnPrefix('read-only'),
      ...(options.base === undefined ? ['--uncommitted'] : ['--base', plain('--base', options.base)])];
    if (options.model !== undefined) argv.push('--model', plain('--model', options.model));
  } else if (command === 'ask' || command === 'do') {
    argv = ['exec', ...turnPrefix(command === 'ask' ? 'read-only' : 'workspace-write'), '-'];
  } else if (command === 'version') argv = ['--version'];
  else if (command === 'login') argv = ['login', 'status'];
  else if (command === 'sandbox') {
    argv = ['sandbox', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', '--',
      plain('execPath', options.execPath), '-e', PROBE_SCRIPT, plain('target', options.target)];
  } else throw new Error(`unknown command ${JSON.stringify(command)}`);
  check(command, argv);
  return argv;
}

function check(command, argv) {
  const fail = (why) => { throw new Error(`refusing to run codex for ${command}: ${why}`); };
  const opts = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
  if (opts.some((a) => FORBIDDEN.some((f) => a === f || a.startsWith(`${f}=`)))) fail('forbidden flag');
  const overrides = opts.flatMap((a, i) => (a === '-c' ? [opts[i + 1]] : []));
  if (overrides.some((c) => !ALLOWED_OVERRIDES.includes(c))) fail('unexpected -c override');
  if (argv[0] !== 'exec' && argv[0] !== 'sandbox') {
    if (overrides.length) fail('override on a command that starts no sandbox');
    return;
  }
  if (overrides.filter((c) => c.startsWith('sandbox_mode=')).length !== 1) fail('needs exactly one sandbox_mode');
  if (!overrides.includes('approval_policy="never"')) fail('needs approval_policy="never"');
  if (argv[0] === 'sandbox') return;
  if (!opts.includes('--json') || !opts.includes('--ignore-user-config')) fail('needs --json and --ignore-user-config');
  if (argv[1] === 'review' && opts.includes('--uncommitted') === opts.includes('--base')) fail('needs exactly one of --uncommitted and --base');
  if (argv[1] !== 'review' && argv.at(-1) !== '-') fail('the prompt must come from stdin');
}

// Reads Codex's JSONL stream as Buffers. Three event shapes decide the result; error events are only kept for display.
export function readStream() {
  const decoder = new StringDecoder('utf8');
  const result = { threadId: null, finalMessage: null, unparseableLines: 0, sawTurnCompleted: false, errors: [] };
  let pending = '';
  const line = (text) => {
    if (!text.trim()) return;
    let event;
    try { event = JSON.parse(text); } catch { result.unparseableLines++; return; }
    if (event?.type === 'thread.started' && typeof event.thread_id === 'string') result.threadId = event.thread_id;
    // Match the item type: reasoning items carry a text field too, and can arrive after the answer.
    else if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      result.finalMessage = event.item.text;
    } else if (event?.type === 'turn.completed') result.sawTurnCompleted = true;
    // Never observed on codex-cli 0.155.1; printed if it arrives, and never taken as the outcome.
    else if (event?.type === 'turn.failed' || event?.type === 'error') result.errors.push(String(event.error?.message ?? event.message));
  };
  return {
    write(chunk) {
      if (!Buffer.isBuffer(chunk)) throw new TypeError('readStream takes Buffers');
      const lines = (pending + decoder.write(chunk)).split('\n');
      pending = lines.pop();
      lines.forEach(line);
    },
    end() {
      line(pending + decoder.end());
      pending = '';
      return result;
    },
  };
}

const seen = (o) => `exit ${o.exit}${o.code ? ` (${o.code})` : ''}, file ${o.created ? 'created' : 'not created'}`;

// reachability: {ok, code}; positive, negative: {exit, created, code}. code is the error code name the probe printed.
export function decideProbe({ reachability, positive, negative }) {
  if (!reachability.ok) {
    return { pass: false, reason: `reachability check failed: the probe target could not be written without a sandbox (${reachability.code}), ` +
      'so the sandbox cannot be tested from here; this says nothing about whether the host can sandbox' };
  }
  if (positive.exit !== 0 || !positive.created) {
    return { pass: false, reason: `positive control failed: a sandboxed write inside the working directory gave ${seen(positive)}; ` +
      'expected exit 0 with the file created, so this host cannot run a sandboxed write' };
  }
  if (negative.exit !== 42 || negative.created) {
    return { pass: false, reason: `negative control failed: a sandboxed write outside the workspace gave ${seen(negative)}; ` +
      'expected exit 42 with no file, so the sandbox is not proven to confine writes' };
  }
  return { pass: true, reason: `workspace-write proven: an inside write landed and an outside write was denied${negative.code ? ` (${negative.code})` : ''}` };
}

// The id is a substituted session id; it is joined into a path that is later deleted.
export const validateRequestId = (s) => typeof s === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(s);

export const requestedLine = (argv) => `requested: codex ${argv.join(' ')}`;

// Always read-only: resume takes its sandbox from the resume command, and a pasted line runs with none of do's checks.
// Quoted for a POSIX shell. An id that would need quoting gets no line.
export const resumeLine = (threadId) => (typeof threadId === 'string' && /^[A-Za-z0-9-]+$/.test(threadId)
  ? `codex exec resume ${threadId} --json --ignore-user-config -c 'approval_policy="never"' -c 'sandbox_mode="read-only"' 'your follow-up here'`
  : null);

// Splitting on whitespace is safe only because review takes no free text. Adding free text needs a different format.
export function parseReviewArgs(text) {
  const args = text.trim() ? text.trim().split(/\s+/) : [];
  const { values } = parseArgs({ args, options: { base: { type: 'string' }, model: { type: 'string' } }, strict: true, allowPositionals: false });
  for (const [name, v] of Object.entries(values)) plain(`--${name}`, v);
  return { base: values.base, model: values.model };
}
