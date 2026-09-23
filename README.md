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
- On Windows, only the standalone Codex install is supported. If only the npm install
  (`codex.cmd`) is on `PATH`, the plugin refuses to run. Windows is unverified: the code
  handles it, but nothing has been run there by hand yet.

## Commands

Every Codex run gets the same safety flags: `--json --ignore-user-config
-c approval_policy="never" -c sandbox_mode="<mode>"`. Codex never asks for approval, your
Codex config file is not read, and the sandbox mode is set on the command line. No command
requests full access.

| Command | Runs | Sandbox |
| --- | --- | --- |
| `/codex-lite:ask <question>` | `codex exec <flags> -`, the question on stdin | `read-only` |
| `/codex-lite:review [--base <ref>] [--model <name>]` | `codex exec review <flags>` with `--uncommitted`, or `--base <ref>`, plus `--model <name>` if given | `read-only` |
| `/codex-lite:do <task>` | `codex exec <flags> -`, the task on stdin | `workspace-write` |
| `/codex-lite:setup` | `codex --version`, `codex login status`, and the sandbox probe | `workspace-write`, probe only |

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
- `do` has no network. It cannot install packages, fetch dependencies or call an API.
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
`read-only` to `workspace-write`, and paste it from the same directory.

Moving a Claude Code session into Codex is out of scope. Codex has its own importer for
sessions from other agents; use that.

## Permissions

The first time a command runs, Claude Code asks permission to write the request file in the
plugin's data directory. That is the one prompt to expect. Each command file lists its own
script call in `allowed-tools`, which is expected to pre-approve it; if Claude Code prompts for
it anyway, `setup` prints the rule to add. `/codex-lite:setup` prints the allow rules you can
add to your settings and adds none itself. A rule that names the plugin's install path
contains the version number and must be updated after each release; the rule for the data
directory does not change.

## Development

```
npm test
npm run lint
```

No dependencies. The tests run against a fake Codex executable and scratch git repositories.
CI runs on Linux, macOS and Windows. On Windows CI the tests that start the fake Codex, start a POSIX shell, or rely on POSIX file
modes are skipped, so a green Windows run says nothing about how the plugin starts Codex.

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
