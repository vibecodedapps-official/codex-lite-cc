// Loaded with --import into every node.exe a Windows test starts. The fake Codex is a .mjs file, which Windows cannot
// spawn, so the tests name node.exe as Codex. When node.exe is started as Codex, its first argument is a Codex
// subcommand, which node takes as the script path: this runs the fake with the same arguments instead. Every other
// node.exe it is loaded into runs as usual.
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { FAKE } from './harness.mjs';

const [, script, ...rest] = process.argv;
if (script && ['exec', 'sandbox'].includes(basename(script))) {
  process.exit(spawnSync(process.execPath, [FAKE, basename(script), ...rest], { stdio: 'inherit' }).status ?? 1);
}
