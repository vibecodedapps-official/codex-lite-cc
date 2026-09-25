# codex-lite-cc

A small Claude Code plugin that hands a task to the Codex CLI, runs it once, and prints what
it said. Four commands, one entry script, no daemon, no hooks, no background jobs of its own.

## Install

```
/plugin marketplace add vibecodedapps-official/codex-lite-cc
/plugin install codex-lite@vibecodedapps-codex-lite
```

Installs track `main`. Every merge to `main` bumps the version.

## Requirements

- Node 22 or later.
- The Codex CLI on `PATH`, logged in (`codex login`).
- On Windows, the standalone install (`codex.exe` on `PATH`) and the npm global install
  (`npm install -g @openai/codex`, which puts `codex.cmd` on `PATH`) both work. A
  `codex.exe` on `PATH` is used first. For the npm install the plugin runs the `codex.exe`
  inside the npm package directly, because a `.cmd` file cannot be started without a
  shell. Codex installed with pnpm, bun or another package manager is not recognized.
- On Windows, Codex's sandbox mode must be set in your Codex config
  (`~/.codex/config.toml`, or `$CODEX_HOME/config.toml`):

  ```toml
  [windows]
  sandbox = "unelevated"
  ```

  Use `"elevated"` instead if you have admin rights and have accepted Codex's one-time
  elevated sandbox setup. Without this setting, Codex's sandbox denies every write and every
  command, even inside the working directory. `do` refuses to run, and `ask` and `review`
  run with a warning. `/codex-lite:setup` reports the value it found. The plugin also reads
  `windows.sandbox = "..."` at the top level of the file and `windows = { sandbox = "..." }`.

## Commands

Every Codex run gets the same safety flags: `--json --ignore-user-config
-c approval_policy="never" -c sandbox_mode="<mode>"`. Codex never asks for approval, your
Codex config file is not read, and the sandbox mode is set on the command line. No command
requests full access. On Windows there is one exception: the plugin reads the `[windows]`
`sandbox` value from your Codex config and passes it as `-c windows.sandbox="<value>"` on
every run and probe, because `--ignore-user-config` would otherwise drop it.

| Command | Runs | Sandbox |
| --- | --- | --- |
| `/codex-lite:ask <question>` | `codex exec <flags> -`, the question on stdin | `read-only` |
| `/codex-lite:review [--base <ref>] [--model <name>]` | `codex exec review <flags>` with `--uncommitted`, or `--base <ref>`, plus `--model <name>` if given | `read-only` |
| `/codex-lite:do <task>` | `codex exec <flags> -`, the task on stdin | `workspace-write` |
| `/codex-lite:setup` | `codex --version`, `codex login status`, and the sandbox probe; on Windows it also reports the Codex sandbox mode | `workspace-write`, probe only |

`ask` and `review` are visible to Claude, so a request in plain words such as "dispatch Codex
to review this" or "ask Codex whether ..." invokes them. The request is then what Claude
passes: a question for `ask`, flags for `review`. `do` and `setup` are hidden from Claude and
run only when you type the command.

`ask`, `review` and `do` refuse to run outside a git repository. `review` also refuses, before
Codex starts, when the base ref does not exist, when it has no merge base with `HEAD`, or when
there is nothing to review. `ask` and `do` take no flags: everything after the command is the
request.

Each result starts with `requested: codex ...`, the exact command that ran, and the working
directory. `do` also prints `HEAD` before and after the run and the working tree state after
it (`git status --porcelain --untracked-files=all --ignored`, cut at fifty lines). It states
what is there, not what changed; reading it is up to you.

## The sandbox probe

Before every `do`, and in `setup`, the plugin checks that the write sandbox actually confines
writes:

1. The plugin writes and removes a file in your home directory itself, so it knows that path
   is writable at all.
2. `codex sandbox` in `workspace-write` mode writes a file in a temporary directory under the
   working directory. This must succeed.
3. `codex sandbox` tries to write the home directory file. This must be denied, with no file
   created.

If any check fails, `do` refuses and says which one and the error it saw. From your home
directory, or a directory above it, the probe cannot work and the plugin says so rather than
claiming the host cannot sandbox.

The probe proves confinement, not capability. A host can confine writes correctly and still
be unable to run any command inside the sandbox, and then Codex may report work it could not
do. `ask` and `review` do not probe; their `read-only` mode is requested, not verified. If a
result looks wrong, run `/codex-lite:setup`.

## Limits and known behaviour

- A `workspace-write` run can also write to the system temporary directory. That is Codex's
  default, not a choice this plugin makes.
- On Windows with `sandbox = "unelevated"`, the probe can pass while Codex still cannot start
  its shell. This was seen on 2026-09-23 with codex-cli 0.156.1 and PowerShell 7 installed
  from the Microsoft Store: every command failed with "CreateProcessAsUserW failed". With
  `"elevated"` the same run worked.
- `do` has no network. It cannot install packages, fetch dependencies or call an API.
- `do` cannot commit. Codex's sandbox denies writes to `.git`, so a commit Codex attempts
  fails and `HEAD` stays where it was. Commit the result yourself. The exception is a
  repository under the system temporary directory on macOS, which the sandbox leaves
  writable: there a commit succeeds, and the footer's `HEAD` line shows it. Seen with a
  repository under `/tmp`. On Windows the same commit was denied in a repository under
  `%TEMP%`.
- The first sandbox call in a new Codex home, one with no `.sandbox-bin` directory yet, took
  about 30 s on Windows while Codex set up its sandbox state, once within the probe's 30 s
  limit and once past it. If `setup` or `do` reports that the positive control did not
  finish in time, run it again.
- `ask` and `do` run on Codex's default model, because your Codex config is not read. There is
  no model flag for them; only `review` takes `--model`.
- Two `do` runs in the same repository are not coordinated. Nothing stops them editing the
  same files.
- A run is stopped after sixty minutes. Claude Code moves a Bash call that passes two minutes
  to the background, so a long run finishes there and its result arrives as a task
  notification. If you set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, Claude Code ends the call
  at its own timeout instead, so no run can pass ten minutes.
- When Codex exits, anything it left running in the background is stopped, on macOS and
  Linux. On Windows, only Codex itself is stopped at the timeout, and its child processes may
  keep running.
- A large review is sent whole and can be slow.
- Your request reaches Codex through two model steps: Claude writes it to a file, then runs
  the script, which sends the file to Codex. Delivery is verbatim on a best-effort basis; a
  very long paste could be altered and nothing detects it.
- `do` and `setup` set `disable-model-invocation`, which stops Claude from invoking them, not
  from repeating their steps. Once a command has run in a session, Claude can write the
  request file and run the script itself when asked in plain words. The command file's
  pre-approval does not apply to that Bash call, so in default permission mode Claude Code
  asks you first. Other permission modes were not tested.

Three Codex behaviours this plugin works around:

- `codex exec review --base <ref>` with a ref that does not exist exits 0 with a confident
  review. The plugin checks the ref with git first.
- A review with an empty diff also exits 0. The plugin checks for changes first.
- A command Codex's sandbox refuses produces no event in the JSON stream, so a count of
  commands says nothing about whether commands ran. The plugin does not count them.

## Following up

When Codex started a thread, the result ends with a resume line you can paste into a
terminal:

```
codex exec resume <thread id> --json --ignore-user-config -c 'approval_policy="never"' -c 'sandbox_mode="read-only"' 'your follow-up here'
```

It always requests `read-only`, even after `do`, because a pasted line runs without any of the
plugin's checks, in whatever directory you are in. To continue a write run, change
`read-only` to `workspace-write`, and paste it from the same directory. On Windows the line
also carries the `-c 'windows.sandbox="<value>"'` the run used.

Moving a Claude Code session into Codex is out of scope. Codex has its own importer for
sessions from other agents; use that.

## Permissions

In default permission mode, expect two prompts every time `ask`, `review` or `do` runs: one to
read the request file and one to write it. The file is in the plugin's data directory, which is
under `~/.claude`, and Claude Code treats files there as sensitive. When Claude invokes `ask`
or `review` from a plain-words request, a prompt to run the command comes first, and the Bash
call is prompted as well, because the command file's pre-approval does not apply to a command
Claude invoked; both were seen on Claude Code 2.1.280 in default mode. A `Skill` allow rule
removes the first, and the Bash allow rule `setup` prints removes the second. The Edit allow
rule `setup` prints for the data directory does not remove the Write prompt; this was checked
on Claude Code 2.1.280. To stop the Write prompt for the rest of a session, choose the prompt's
option to allow Claude to edit files in its `~/.claude` folder.

Each command file lists its own script call in `allowed-tools`, which pre-approves it when you
type the command, so that Bash call is not prompted. `/codex-lite:setup` prints allow rules
you can add to your settings and adds none itself. It prints them as JSON strings, ready to
paste into the `permissions.allow` array. The Bash rule names the installed version's path, so
it must be updated after each release; until then Claude asks again. It has no `*` in the
path, because Claude Code's `*` would also match another plugin's directory or a path through
`..`. On Windows its path uses forward slashes (`C:/Users/...`), because that is how Claude
Code writes the plugin root into the command the rule must match.

## Development

```
npm test
npm run lint
```

No dependencies. The tests run against a fake Codex executable and scratch git repositories.
CI runs on Linux, macOS and Windows. On Windows CI the tests that start the fake Codex, start a POSIX shell, or rely on POSIX file
modes are skipped. The Windows-only tests cover how the plugin finds Codex on `PATH`, not what it does with it.

Test-only environment variables, read once at startup:

- `CODEX_LITE_CODEX_BIN`: path to the Codex executable.
- `CODEX_LITE_TIMEOUT_MS`: replaces the sixty-minute run limit and the thirty-second limit on
  every other process.
- `CODEX_LITE_PROBE_TARGET`: the file the sandbox probe tries to write outside the working
  directory. Defaults to `~/.codex-lite-sandbox-probe-<pid>`, one file per run.

To try a change by hand, start Claude Code from a scratch git repository with the working
tree loaded as a plugin:

```
claude --plugin-dir /path/to/codex-lite-cc/plugins/codex-lite
```

`docs/acceptance.md` lists the checks run by hand before each release.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
