#!/usr/bin/env node
// Stands in for the Codex CLI in tests. Appends its argv as one JSON line to $FAKE_CODEX_ARGV (a do run calls it three
// times), writes the stdin it reads to $FAKE_CODEX_STDIN, and appends the pids a test must check to $FAKE_CODEX_PIDS.
// $FAKE_CODEX picks a behaviour; the default is a good run. The stream shapes are those of codex-cli 0.155.1.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const argv = process.argv.slice(2);
const { FAKE_CODEX_ARGV, FAKE_CODEX_STDIN, FAKE_CODEX_PIDS } = process.env;
const mode = process.env.FAKE_CODEX || 'ok';
if (FAKE_CODEX_ARGV) appendFileSync(FAKE_CODEX_ARGV, `${JSON.stringify(argv)}\n`);

const THREAD = '01a0cc8d-ada9-7501-a8e1-f64ad8e79180';
const pid = (p) => appendFileSync(FAKE_CODEX_PIDS, `${p}\n`);
const idle = () => setInterval(() => {}, 1000);
const lines = (events) => events.map((e) => `${JSON.stringify(e)}\n`).join('');
const started = { type: 'thread.started', thread_id: THREAD };
const message = { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'fake answer' } };
const completed = { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
const readStdin = (then) => {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c)).on('end', () => {
    if (FAKE_CODEX_STDIN) writeFileSync(FAKE_CODEX_STDIN, Buffer.concat(chunks));
    then();
  });
};
const sleeper = (stdio) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio });
const stubborn = () => spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"], { stdio: 'ignore' });

if (argv[0] === '--version') {
  if (mode === 'version-ignores-sigterm') { process.on('SIGTERM', () => {}); pid(process.pid); idle(); } else console.log('codex-cli 0.155.1');
} else if (argv[0] === 'login') {
  console.log('Logged in using ChatGPT');
} else if (argv[0] === 'sandbox') {
  // Runs the command after "--" for real. 'confine' (the default) denies a write outside the working directory the
  // way a working sandbox does; 'sandbox-open' confines nothing; 'sandbox-broken' can launch nothing.
  const command = argv.slice(argv.indexOf('--') + 1);
  const rel = relative(process.cwd(), resolve(command.at(-1)));
  if (mode === 'sandbox-broken') process.exit(71);
  if (mode !== 'sandbox-open' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    process.stderr.write('EPERM');
    process.exit(42);
  }
  process.exit(spawnSync(command[0], command.slice(1), { stdio: 'inherit' }).status ?? 1);
} else if (mode === 'stderr-early') {
  // Exits without reading stdin, the way Codex refuses an untrusted directory.
  process.stderr.write('Not inside a trusted directory and --skip-git-repo-check was not specified.\n');
  process.exitCode = 1;
} else if (mode === 'hang') {
  const child = sleeper('ignore');
  pid(child.pid);
  idle();
} else if (mode === 'hang-stubborn-child') {
  // The fake itself dies on SIGTERM; its child does not.
  pid(stubborn().pid);
  idle();
} else if (mode === 'leaves-stubborn-child') {
  // A good run that leaves a background process behind. The delay lets the child install its SIGTERM handler.
  const child = stubborn();
  child.unref();
  pid(child.pid);
  setTimeout(() => process.stdout.write(lines([started, message, completed])), 500);
} else if (mode === 'turn-failed') {
  // Shape from the Codex non-interactive documentation; never observed on codex-cli 0.155.1.
  process.stdout.write(lines([started, { type: 'turn.failed', error: { message: 'usage limit reached' } }]));
  process.exitCode = 1;
} else if (mode === 'ignores-sigterm') {
  process.on('SIGTERM', () => {});
  pid(process.pid);
  idle();
} else if (mode === 'holds-stdout') {
  process.stdout.write(lines([started, message, completed]), () => {
    const child = sleeper(['ignore', 'inherit', 'inherit']);
    pid(child.pid);
    child.unref();
  });
} else if (mode === 'floods-stdout') {
  // A megabyte of ignored events before reading stdin: a parent that writes stdin before reading stdout deadlocks.
  const pad = { type: 'item.updated', pad: 'x'.repeat(1000) };
  process.stdout.write(lines(Array(1100).fill(pad)), () => readStdin(() => process.stdout.write(lines([started, message, completed]))));
} else {
  const finish = () => {
    if (mode === 'commits') {
      writeFileSync('.env', 'SECRET=1\n');
      spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'fake'], { stdio: 'ignore' });
    }
    const events = { 'no-turn': [started, message], 'no-message': [started, completed] }[mode] ?? [started, message, completed];
    process.stdout.write(lines(events));
    if (mode === 'exit1') { process.stderr.write('fake failure on stderr\n'); process.exitCode = 1; }
  };
  if (argv.at(-1) === '-') readStdin(finish); else finish();
}
