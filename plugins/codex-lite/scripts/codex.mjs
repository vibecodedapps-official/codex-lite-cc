// Pure half: inputs to argv arrays, bytes to a result. No filesystem, spawn, clock or environment (node:path only tests a string's shape).
// Errors and refusal reasons here carry no "codex-lite:" prefix; the entry script adds it once.
import { StringDecoder } from 'node:string_decoder';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';

// Codex's Windows sandbox mode, when given, is passed on every sandboxed call: --ignore-user-config drops the user's own.
const windowsFlag = (windowsSandbox) => (windowsSandbox === undefined ? [] : ['-c', `windows.sandbox="${windowsSandbox}"`]);
const turnPrefix = (mode, windowsSandbox) => ['--json', '--ignore-user-config', '-c', 'approval_policy="never"', '-c', `sandbox_mode="${mode}"`,
  ...windowsFlag(windowsSandbox)];
const FORBIDDEN = ['--color', '--ephemeral', '--sandbox', '-s', '--skip-git-repo-check', '--ignore-rules', '--full-auto',
  '--dangerously-bypass-approvals-and-sandbox', '--last', '--all'];
export const WINDOWS_SANDBOXES = ['unelevated', 'elevated'];
const ALLOWED_OVERRIDES = ['approval_policy="never"', 'sandbox_mode="read-only"', 'sandbox_mode="workspace-write"',
  ...WINDOWS_SANDBOXES.map((m) => `windows.sandbox="${m}"`)];

// Run as `node -e PROBE_SCRIPT <target>`. Exits 0 when the write lands, 42 when it is denied (macOS says EPERM,
// Windows and Linux sandboxes say EACCES), 9 on anything else; the error code name goes to stderr.
export const PROBE_SCRIPT = 'try{require("fs").writeFileSync(process.argv[1],"x");process.exit(0)}catch(e){' +
  'process.stderr.write(String(e&&e.code));process.exit(e&&(e.code==="EPERM"||e.code==="EACCES")?42:9)}';

// The npm install's native binary on Windows, by Node arch: [platform package, target], as its bin/codex.js names them.
export const NPM_WIN32 = { x64: ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc'], arm64: ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc'] };

// A value starting with "-" would reach Codex or git as an option.
const plain = (name, v) => {
  if (typeof v !== 'string' || v === '' || v.startsWith('-')) throw new Error(`${name} ${JSON.stringify(v)} is empty or starts with "-"; refused`);
  return v;
};

// A Codex thread id, as printed in thread.started and accepted by exec resume: letters, digits and hyphens, and
// (unlike plain()) never leading with "-", so it cannot be read as an option. validThreadId is shared by resumeLine,
// parseAskArgs, buildArgv/check, and the saved-thread-file read and save in codex-lite.mjs.
const THREAD_ID = /^[A-Za-z0-9-]+$/;
export const validThreadId = (v) => typeof v === 'string' && THREAD_ID.test(v) && !v.startsWith('-');
const checkId = (v) => { if (!validThreadId(v)) throw new Error(`--resume id ${JSON.stringify(v)} is malformed; refused`); return v; };

export function buildArgv(command, options = {}) {
  let argv;
  if (command === 'review') {
    argv = ['exec', 'review', ...turnPrefix('read-only', options.windowsSandbox),
      ...(options.base === undefined ? ['--uncommitted'] : ['--base', plain('--base', options.base)])];
    if (options.model !== undefined) argv.push('--model', plain('--model', options.model));
  } else if (command === 'ask' && options.resume !== undefined) {
    // Always read-only: resume takes its sandbox from the command line, not from what started the thread.
    argv = ['exec', 'resume', checkId(options.resume), ...turnPrefix('read-only', options.windowsSandbox),
      ...(options.model !== undefined ? ['--model', plain('--model', options.model)] : []), '-'];
  } else if (command === 'ask' || command === 'do' || command === 'implement') {
    argv = ['exec', ...turnPrefix(command === 'ask' ? 'read-only' : 'workspace-write', options.windowsSandbox),
      ...(command !== 'do' && options.model !== undefined ? ['--model', plain('--model', options.model)] : []), '-'];
  } else if (command === 'version') argv = ['--version'];
  else if (command === 'login') argv = ['login', 'status'];
  else if (command === 'sandbox') {
    argv = ['sandbox', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', ...windowsFlag(options.windowsSandbox), '--',
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
  if (overrides.filter((c) => c.startsWith('windows.sandbox=')).length > 1) fail('more than one windows.sandbox');
  if (!overrides.includes('approval_policy="never"')) fail('needs approval_policy="never"');
  if (argv[0] === 'sandbox') return;
  if (!opts.includes('--json') || !opts.includes('--ignore-user-config')) fail('needs --json and --ignore-user-config');
  if (argv[1] === 'review' && opts.includes('--uncommitted') === opts.includes('--base')) fail('needs exactly one of --uncommitted and --base');
  // argv[2] is checked here, explicitly, rather than by the opts/FORBIDDEN scan above, so a malformed or "-"-leading id cannot hide from it.
  if (argv[1] === 'resume') {
    if (!validThreadId(argv[2])) fail('resume needs a valid thread id');
    if (!overrides.includes('sandbox_mode="read-only"')) fail('resume must be read-only');
  }
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
      'expected exit 0 with the file created, so Codex\'s sandbox denied a write it should allow' };
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
export const resumeLine = (threadId, windowsSandbox) => (validThreadId(threadId)
  ? `codex exec resume ${threadId} --json --ignore-user-config -c 'approval_policy="never"' -c 'sandbox_mode="read-only"' ` +
    `${windowsSandbox === undefined ? '' : `-c 'windows.sandbox="${windowsSandbox}"' `}'your follow-up here'`
  : null);

// The windows.sandbox value in a Codex config.toml, or undefined: a key of a [windows] table, a top-level dotted key,
// or a top-level inline table. Lines inside a multiline string are text, not keys, so they are skipped.
const SANDBOX_KEY = String.raw`(?:sandbox|"sandbox"|'sandbox')\s*=\s*(?:"([^"]*)"|'([^']*)')`;
const IN_TABLE = new RegExp(`^${SANDBOX_KEY}$`);
const DOTTED = new RegExp(String.raw`^(?:windows|"windows"|'windows')\s*\.\s*${SANDBOX_KEY}$`);
const INLINE = /^(?:windows|"windows"|'windows')\s*=\s*\{(.*)\}$/;
// The key/value pairs of an inline table's body: split on the commas outside strings and nested tables or arrays.
function inlinePairs(body) {
  const pairs = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'") {
      for (i++; i < body.length && body[i] !== c;) i += c === '"' && body[i] === '\\' ? 2 : 1;
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) { pairs.push(body.slice(start, i).trim()); start = i + 1; }
  }
  return [...pairs, body.slice(start).trim()];
}
const atRoot = (line) => DOTTED.exec(line) ?? inlinePairs(INLINE.exec(line)?.[1] ?? '').map((p) => IN_TABLE.exec(p)).find(Boolean);
// Scans one line from the multiline string open at its start: returns the one open at its end, and where its comment starts.
function scanLine(raw, open) {
  for (let i = 0; i < raw.length;) {
    if (open) {
      const end = raw.indexOf(open, i);
      if (end < 0) break;
      [i, open] = [end + 3, null];
    } else if (raw[i] === '#') return { open, cut: i };
    else if (raw.startsWith('"""', i) || raw.startsWith("'''", i)) [i, open] = [i + 3, raw.slice(i, i + 3)];
    else if (raw[i] === '"' || raw[i] === "'") {
      const q = raw[i++];
      while (i < raw.length && raw[i] !== q) i += q === '"' && raw[i] === '\\' ? 2 : 1;
      i++;
    } else i++;
  }
  return { open, cut: raw.length };
}

export function windowsSandboxSetting(toml) {
  let table = '', open = null;
  for (const raw of toml.split('\n')) {
    const wasOpen = open;
    let cut;
    ({ open, cut } = scanLine(raw, open));
    if (wasOpen || open) continue; // a line that is part of a multiline string holds no key this reads
    const line = raw.slice(0, cut).trim();
    const header = /^\[\[?\s*["']?([^\]"']*?)["']?\s*\]\]?$/.exec(line);
    if (header) { table = header[1]; continue; }
    const m = table === 'windows' ? IN_TABLE.exec(line) : table === '' ? atRoot(line) : null;
    if (m) return m.slice(1).find((v) => v !== undefined);
  }
  return undefined;
}

// --timeout <seconds>, for ask and review: bounds the Codex turn. 3600 keeps the fixed limit's maximum.
const seconds = (v) => {
  if (typeof v !== 'string' || !/^[1-9][0-9]*$/.test(v) || Number(v) > 3600) {
    throw new Error(`--timeout ${JSON.stringify(v ?? '')} is not a whole number of seconds from 1 to 3600; refused`);
  }
  return Number(v);
};

// Splitting on whitespace is safe only because review takes no free text. Adding free text needs a different format.
// --cwd, as for implement, is the one line option: the last non-empty line, and nowhere else.
export function parseReviewArgs(text) {
  const lines = text.trimEnd().split('\n'), cwdLine = /^\s*--cwd(?=[= \t\r]|$)/;
  const cwd = cwdLine.test(lines.at(-1)) ? matchCwd(lines.pop()).value : undefined;
  if (lines.some((l) => /(?:^|\s)--cwd(?=[=\s]|$)/.test(l))) throw new Error('--cwd must be the last line; refused');
  const rest = lines.join('\n').trim(), args = rest ? rest.split(/\s+/) : [];
  // parseArgs keeps the last of two values silently; ask refuses a second of any option, so review does too.
  for (const name of ['base', 'model', 'timeout']) {
    if (args.filter((a) => a === `--${name}` || a.startsWith(`--${name}=`)).length > 1) throw new Error(`--${name} given more than once; refused`);
  }
  const { values } = parseArgs({ args, options: { base: { type: 'string' }, model: { type: 'string' }, timeout: { type: 'string' } },
    strict: true, allowPositionals: false });
  for (const name of ['base', 'model']) if (values[name] !== undefined) plain(`--${name}`, values[name]);
  return { base: values.base, model: values.model, timeout: values.timeout === undefined ? undefined : seconds(values.timeout), ...(cwd === undefined ? {} : { cwd }) };
}

// Only leading --model, --resume and --timeout are options, in any order, each at most once: ask's text is free, so either
// spelling later on is part of the question. Each match consumes its value and the one delimiter after it (space,
// tab, or a newline with or without a carriage return), so the question is exactly what is left, kept verbatim.
// Whitespace before an option is skipped, so extra spaces or lines between two options do not turn the second into
// question text. --model and --timeout share the grammar and differ only in how the value is checked.
function matchValue(name, check, s) {
  const m = new RegExp(`^\\s*--${name}(?:=(\\S*)|\\s+(\\S*)|$)(?:\\r?\\n|[ \\t])?`).exec(s);
  return m && { value: check(m[1] ?? m[2] ?? ''), rest: s.slice(m[0].length) };
}
const matchModel = (s) => matchValue('model', (v) => plain('--model', v), s);
const matchTimeout = (s) => matchValue('timeout', seconds, s);

// --resume=<id> or --resume <id> (same line): explicit id, checked against THREAD_ID. --resume followed by a
// newline, end of text, or another option (--resume --model x, --resume --timeout 5): bare, resumed id comes from the saved thread file.
function matchResume(s) {
  const m = /^\s*--resume(?=[=\s]|$)/.exec(s);
  if (!m) return null;
  const rest = s.slice(m[0].length);
  if (rest[0] === '=') {
    const v = /^\S*/.exec(rest.slice(1))[0];
    return { value: checkId(v), rest: s.slice(m[0].length + 1 + v.length + 1) };
  }
  // Spaces or tabs, any number of them, then either a (possibly CRLF) newline or end of text: bare.
  const sp = /^[ \t]*/.exec(rest)[0];
  const after = rest.slice(sp.length);
  const nl = /^\r?\n/.exec(after);
  if (after === '' || nl) return { value: true, rest: s.slice(m[0].length + sp.length + (nl ? nl[0].length : 0)) };
  const token = /^\S*/.exec(after)[0];
  if (/^--(?:model|resume|timeout)(?:=|$)/.test(token)) return { value: true, rest: s.slice(m[0].length + sp.length) };
  return { value: checkId(token), rest: s.slice(m[0].length + sp.length + token.length + 1) };
}

export function parseAskArgs(text) {
  let model, resume, timeout, s = text;
  for (;;) {
    const m = matchModel(s);
    if (m) {
      if (model !== undefined) throw new Error('--model given more than once; refused');
      ({ value: model, rest: s } = m); continue;
    }
    const r = matchResume(s);
    if (r) {
      if (resume !== undefined) throw new Error('--resume given more than once; refused');
      ({ value: resume, rest: s } = r); continue;
    }
    const t = matchTimeout(s);
    if (t) {
      if (timeout !== undefined) throw new Error('--timeout given more than once; refused');
      ({ value: timeout, rest: s } = t); continue;
    }
    break;
  }
  return { model, resume, timeout, question: s };
}

// --cwd <path> or --cwd=<path>, the last option of implement: the value is the rest of its line (internal spaces and
// backslashes kept; trailing spaces and tabs and a carriage return belong to the line end), so the task starts on the next line.
function matchCwd(s) {
  const m = /^\s*--cwd(?:=|[ \t]+|(?=\r?\n|$))([^\n]*?)[ \t]*\r?(?:\n|$)/.exec(s);
  if (m && !isAbsolute(m[1])) throw new Error(`--cwd ${JSON.stringify(m[1])} is empty or not an absolute path; refused`);
  return m && { value: m[1], rest: s.slice(m[0].length) };
}

// --model and --timeout as for ask, then --cwd last; a --model, --timeout or second --cwd right after the --cwd line is refused;
// --resume, and anything else, is task text.
const dup = (name) => { throw new Error(`--${name} given more than once; refused`); };
export function parseImplementArgs(text) {
  let model, timeout, cwd, s = text, m;
  for (;;) {
    if ((m = matchModel(s))) { if (model !== undefined) dup('model'); model = m.value; }
    else if ((m = matchTimeout(s))) { if (timeout !== undefined) dup('timeout'); timeout = m.value; }
    else break;
    s = m.rest;
  }
  if ((m = matchCwd(s))) {
    ({ value: cwd, rest: s } = m);
    const next = /^\s*--(cwd|model|timeout)(?=[=\s]|$)/.exec(s);
    if (next?.[1] === 'cwd') dup('cwd');
    if (next) throw new Error('--cwd must be the last option; refused');
  }
  return { model, timeout, cwd, task: s };
}
