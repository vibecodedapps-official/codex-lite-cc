# codex-lite-cc

A small Claude Code plugin that hands a task to the Codex CLI, runs it once, and prints what
it said. Five commands, one entry script, one prompt hook, no daemon, no background jobs of its own.

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
  command, even inside the working directory. `do` and `implement` refuse to run, and `ask` and `review`
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
| `/codex-lite:ask [--model <name>] [--resume <thread id>] [--timeout <seconds>] <question>`, or `--resume` alone on the first line and the question below it | `codex exec <flags> -`, or `codex exec resume <thread id> <flags> -` with `--resume`, plus `--model <name>` if given, the question on stdin | `read-only` |
| `/codex-lite:review [--base <ref>] [--model <name>] [--timeout <seconds>]` | `codex exec review <flags>` with `--uncommitted`, or `--base <ref>` (the net difference from the merge base of `<ref>` and `HEAD` to the working tree, tracked files only), plus `--model <name>` if given | `read-only` |
| `/codex-lite:do <task>` | `codex exec <flags> -`, the task on stdin | `workspace-write` |
| `/codex-lite:implement [--model <name>] [--timeout <seconds>] [--cwd <absolute path>] <task>`, with `--cwd` last and alone on its line, the task below it | as `do`, plus `--model <name>` if given, run in `--cwd` if given | `workspace-write` |
| `/codex-lite:setup` | `codex --version`, `codex login status`, and the sandbox probe; on Windows it also reports the Codex sandbox mode | `workspace-write`, probe only |

`ask` and `review` are visible to Claude, so a request in plain words such as "dispatch Codex
to review this" or "ask Codex whether ..." invokes them. The request is then what Claude
passes: a question for `ask`, flags for `review`. In auto mode this runs with no approvals.
`ask` is for questions, plan critiques, second opinions and follow-ups. `review` is only for
code changes: the uncommitted working tree, or the diff against a base ref. A plan written in
the conversation is not a diff, so "review this plan with Codex" goes to `ask`.
When Claude invokes `ask` or `review` as one step of a larger request, it forwards Codex's
output and then continues that request; when you type the command, or ask only for Codex's
answer, the output is the whole reply.
`implement` is visible to Claude too, but only for a change that a skill you invoked delegates
to Codex as one of its steps. A request typed in plain words, even one that names Codex, is
not a delegation: asked to have Codex change files, Claude tells you to type
`/codex-lite:do <task>`.
`do` and `setup` are hidden from Claude and run only when you type the command.

This is a tradeoff. Before `implement`, no Codex write happened unless you typed a command. Now
a skill can start a write turn, so writes are no longer gated on a typed command. In default
permission mode Claude Code still asks before the Skill call; in auto mode, as observed for
`ask` and `review`, it does not ask. `implement` runs the same probe, sandbox and footer as
`do`, and cannot reach the network or, with one exception, commit (see the limits below).

`ask`, `review`, `do` and `implement` refuse to run outside a git repository. `review` also refuses, before
Codex starts, when the base ref does not exist, when it has no merge base with `HEAD`, or when
there is nothing to review. `review` takes `--base <ref>`, `--model <name>` and
`--timeout <seconds>`, each at most once; a repeated flag is refused before Codex starts.
It also takes `--cwd <absolute path>` or `--cwd=<path>` on its own line, the last line of the
request, to review a repository other than the shell's, such as a worktree: the value is the
rest of its line, verbatim, and must be an existing directory inside a git repository. A
`--cwd` anywhere else is refused.
With `--base`, as in Codex, what is reviewed is the
net difference from the merge base of the base and `HEAD` to the working tree: commits, staged
and unstaged changes together, tracked files only. An untracked file is not compared, so
`git add` it first; a change that a later change undoes is invisible.

`ask` takes three optional leading flags, in any order, each at most once: `--model <name>` or
`--model=<name>`, `--resume`, and `--timeout <seconds>` or `--timeout=<seconds>`. Everything
after the last flag and its delimiter is the question, so a `--model`, `--resume` or
`--timeout` later in the question is plain text. `ask` refuses a missing model name, or one
that starts with `-`. `--resume` on its own, followed by a newline, the end of the text, or
another flag, continues the last Codex thread this Claude session started;
`--resume <thread id>` or `--resume=<thread id>` continues that thread instead. A word after
`--resume` on the same line is always read as the thread id, not as the start of the question,
so the bare form needs a line of its own, or `--model` or `--timeout` directly after it. See
"Following up" below for what `--resume` does and how it fails. `do` takes no flags:
everything after the command is the request.

`implement` takes three optional leading options. `--model <name>` (or `--model=<name>`) and
`--timeout <seconds>` (or `--timeout=<seconds>`) come first, in either order, each at most
once, and mean what they do for `ask`. `--cwd <absolute path>` (or `--cwd=<absolute path>`)
comes last and is alone on its line: its value is the rest of the line, verbatim, so a path with
spaces or Windows backslashes is carried intact, and the task starts on the next line. A
`--model`, `--timeout` or second `--cwd` directly after the `--cwd` line is refused. The path
must be absolute and an existing directory inside a git repository
(`git -C <path> rev-parse --show-toplevel` succeeds), or `implement` refuses before Codex runs.
Codex then runs in that directory, and the write sandbox is bounded to it; without `--cwd` it
runs in the shell's directory, as `do` does. This is for a worktree, or another repository of
a multi-repository run, whose checkout is not the session's directory. Note what that means:
the invoking skill, not you, chooses the repository Codex writes in, and nothing ties it to
the session's repository; any git checkout on disk is accepted. The write sandbox, the
no-commit rule and the tree footer apply there as they do here, and a wrong choice is undone
with git. The tree state in the footer still covers the whole repository, as for `do`. Its
value has trailing spaces and tabs dropped, so a request line that ends with a space still
names the path. There is no `--resume`: every call
starts a new thread, and a `--resume` in the text is part of the task. The task is the text
after the options; an empty task is refused. For example:

```
/codex-lite:implement --timeout 900 --cwd /work/my repo-wt
Add a subtract function to math.mjs, with a test.
```

`--timeout <seconds>`, on `ask`, `review` and `implement`, is a whole number from 1 to 3600; any other
value, or a second `--timeout`, is refused before Codex starts. It replaces the sixty-minute
limit on the Codex turn for that call only. It bounds the turn, not the whole call: the local
git checks come before the turn, and stopping Codex at the deadline can take up to ten more
seconds. The flag is not passed to Codex, so the `requested:` line does not show it.

Each result starts with `requested: codex ...`, the exact command that ran, and the working
directory, and ends with `status: ...`, one of four words, on a line of its own after
everything else. `status: refused` means the plugin stopped before attempting the task turn:
bad arguments, nothing to review, not a repository, a bad or missing request file, or a failed
`do` or `implement` probe. `status: timeout` means the turn was attempted and its deadline ended it.
`status: failed` means the turn was attempted and something else went wrong: Codex could not
start, exited non-zero, sent no final message or reported an error, or the `do` or `implement` tree state
could not be read; a crash of the plugin itself, before or after the turn, is `failed` too. `status: ok` means the run and all its reporting completed, not that a
review found nothing. The exit code is 0 for `ok` and 1 otherwise. A result with no `status:`
line was cut off, by the Bash tool's timeout or a kill, and is incomplete. The plugin does not
tell model, login or sandbox failures apart: Codex reports them as prose, which the
`codex-lite: the run failed:` line carries. `setup` prints no status line.

`ask` and `review` run from the top of the repository, whatever directory the shell is in; `do` and `implement` run from the shell's directory, or from `--cwd` for `implement`, which bounds where they can write; `review` runs from the top of the repository holding its `--cwd`, if given. `ask` and
`review` also print a line saying the sandbox has no network. `do` and `implement` also print `HEAD` before
and after the run and the working tree state after it
(`git status --porcelain --untracked-files=all --ignored`, cut at fifty lines). It states what
is there, not what changed; reading it is up to you.

## The sandbox probe

Before every `do` and `implement`, and in `setup`, the plugin checks that the write sandbox actually confines
writes:

1. The plugin writes and removes a file in your home directory itself, so it knows that path
   is writable at all.
2. `codex sandbox` in `workspace-write` mode writes a file in a temporary directory under the
   working directory. This must succeed.
3. `codex sandbox` tries to write the home directory file. This must be denied, with no file
   created.

If any check fails, `do` and `implement` refuse and say which one and the error it saw. From your home
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
- `do` and `implement` have no network. They cannot install packages, fetch dependencies or call an API.
- `ask` and `review` have no network either, so Codex cannot read an issue, a pull request or a
  web page, and the commands forward a request unchanged without fetching anything. A typed
  `/codex-lite:ask Evaluate issue #12` sends `#12` to Codex as it is. Fetch it before you run
  `ask`, and save it under a directory the repository already ignores, so
  `review --uncommitted` does not review it as a change. Check the directory with
  `git check-ignore`, then, if `.scratch/` is ignored, run
  `gh issue view 12 > .scratch/issue-12.md` and name the file in the question by its
  repository-relative path. With no ignored directory, paste the fetched text into the
  question instead. When Claude invokes `ask` itself, its description tells Claude to do
  this first.
- `do` and `implement` cannot commit. Codex's sandbox denies writes to `.git`, so a commit Codex attempts
  fails and `HEAD` stays where it was. Commit the result yourself. The exception is a
  repository under the system temporary directory, which the sandbox leaves writable: there
  a commit succeeds, and the footer's `HEAD` line shows it. Seen on macOS with a repository
  under `/tmp`.
- `do`, and `ask`, `review` or `implement` without `--model`, run on Codex's default model,
  because your Codex config is not read. `do` has no model flag.
- Two `do` or `implement` runs in the same repository are not coordinated. Nothing stops them editing the
  same files.
- A run is stopped after 60 minutes unless `--timeout` says otherwise. The command files ask
  for the Bash tool's longest timeout, ten minutes. Claude Code moves a call that passes it to the background, where the
  run finishes and its result arrives as a task notification. If you set
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, Claude Code ends the call at its timeout instead,
  so no run can pass ten minutes.
- When Codex exits, anything it left running in the background is stopped, on macOS and
  Linux. On Windows, only Codex itself is stopped at the timeout, and its child processes may
  keep running.
- A large review is sent whole and can be slow.
- Your request reaches Codex through two model steps: Claude writes it to a file, then runs
  the script, which sends the file to Codex. Delivery is verbatim on a best-effort basis; a
  very long paste could be altered and nothing detects it.
- One call at a time per Claude session, `implement` included. Each session has one request file and one saved
  thread file in the plugin's data directory, and the script deletes the request file when it
  reads it. A second call that starts before the first has read its request file can take or
  lose the other's request, and the saved thread is whichever run saved last; a failure to
  save it only warns.
- `do` and `setup` set `disable-model-invocation`, which stops Claude from invoking them, not
  from repeating their steps. `implement` does not set it, so Claude can invoke it when a skill
  delegates a change; see "Commands" for the tradeoff. Once a command has run in a session, Claude can write the
  request file and run the script itself when asked in plain words. In default permission
  mode Claude Code asks you before that Bash call.

Three Codex behaviours this plugin works around:

- `codex exec review --base <ref>` with a ref that does not exist exits 0 with a confident
  review. The plugin checks the ref with git first.
- A review with an empty diff also exits 0. The plugin checks for changes first.
- A command Codex's sandbox refuses produces no event in the JSON stream, so a count of
  commands says nothing about whether commands ran. The plugin does not count them.

## Following up

To continue a Codex thread, run `ask` again with `--resume`. Give the thread id from the
result's `thread` line, as `--resume <thread id>` or `--resume=<thread id>`, or leave it out and
put a bare `--resume` on its own line before the question: that continues the last thread this
Claude session started, whichever command started it. A bare `--resume` must end its line, or
come directly before `--model` or `--timeout`, because any word after it on the same line is read as the
thread id instead; a word that is not a valid id (one with a `;` or a `?`, for example) is
refused before Codex runs. For example:

```
/codex-lite:ask --resume <thread id> What about the second objection?
```

```
/codex-lite:ask --resume
What about the second objection?
```

After every successful `ask`, `review`, `do` or `implement`, the plugin saves that run's thread id to
`thread-<session id>.txt` in the plugin's data directory, next to the request file: one small
file per Claude session, replaced each time a run succeeds. A failed run leaves it unchanged.
A later bare `--resume` in the same session reads that file, so you never have to copy the id
by hand. Resume always runs `read-only`, even if the thread came from `do` or `implement`, because it takes
its sandbox from the command line, not from how the thread started. A bare `--resume` is
refused before Codex runs when the session has no saved thread id yet. A stale or unknown id,
saved or typed, is not caught by the plugin; Codex itself refuses it, with its own "no rollout
found" error. The plugin does not use Codex's own `--last` flag for the bare form, because
`--last` picks the newest session for the working directory, which can belong to another
Claude session, not this one.

When Codex started a thread, the result also ends with a resume line you can paste into a
terminal:

```
codex exec resume <thread id> --json --ignore-user-config -c 'approval_policy="never"' -c 'sandbox_mode="read-only"' 'your follow-up here'
```

It always requests `read-only`, even after `do` or `implement`, because a pasted line runs without any of the
plugin's checks, in whatever directory you are in. To continue a write run, change
`read-only` to `workspace-write`, and paste it from the directory the `do` or `implement` result's `cwd:` line
names; after an `implement` run with `--cwd`, that is the `--cwd` directory. On Windows the line also carries the `-c 'windows.sandbox="<value>"'` the run used.

Moving a Claude Code session into Codex is out of scope. Codex has its own importer for
sessions from other agents; use that.

## Hooks

The plugin adds one `UserPromptSubmit` hook. When a prompt you send mentions Codex, in any
case, the hook adds a short routing note to Claude's context: use `ask` for questions and plan
critiques, `review` only for diffs, put options before the question in any order (a model
choice as `--model <name>`, and for a follow-up in the same Codex thread `--resume <thread id>`
or a bare `--resume` followed by a line break or another option), send file changes to
`/codex-lite:do`, except that a skill which delegates implementation to Codex uses
`implement`, and do not run Codex directly. A prompt that starts with a slash command
(a slash and a command name, then a space or the end) gets no note, whichever plugin the
command belongs to, because a typed command already routes itself; a prompt that starts with
an absolute path is not a command and gets the note. A prompt that does not
mention Codex gets nothing. The note is guidance: Claude usually follows it, but it does not
stop Claude from running Codex some other way.

## Permissions

In auto mode, `ask` and `review` run with no approvals, whether you type the command or ask in
plain words. This was seen on 2026-09-26 on Claude Code 2.1.280 in headless auto mode, for
"dispatch codex to review my changes against main" and "ask codex what math.mjs exports".

In auto mode, by inference from that observation for `ask` and `review`, `implement` invoked by a
skill is not gated either; nobody has yet observed it, and item 19 of `docs/acceptance.md` is where
it gets recorded. See the tradeoff under "Commands".

In default mode, Claude Code asks before each step it does not trust: running a command Claude
invoked on its own, writing the request file (it is under `~/.claude`, which Claude Code
treats as sensitive), and running the script when Claude invoked the command. When you type
the command, the script call is pre-approved by the command file.

`/codex-lite:setup` prints allow rules for default mode as JSON strings, ready to paste into
`permissions.allow`; it adds none itself. The Bash rule names the installed version's path,
so update it after each release. It has no `*` in the path, because Claude Code's `*` would
also match another plugin's directory or a path through `..`. On Windows the path uses
forward slashes (`C:/Users/...`), because that is how Claude Code writes the plugin root into
the command.

Optionally, to stop Claude from running the Codex CLI directly through Bash, add a deny rule
to your Claude Code settings:

```json
{
  "permissions": {
    "deny": ["Bash(codex *)"]
  }
}
```

It blocks ordinary direct calls such as `codex exec ...` and leaves the plugin's `node` command
alone. It does not cover every way to start Codex: an absolute path to the executable, or
`npx @openai/codex`, still gets through. `setup` does not print this rule.

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
  every other process. An `ask`, `review` or `implement` `--timeout` still wins for the Codex turn.
- `CODEX_LITE_PROBE_TARGET`: the file the sandbox probe tries to write outside the working
  directory. Defaults to `~/.codex-lite-sandbox-probe-<pid>`, one file per run.

To try a change by hand, start Claude Code from a scratch git repository with the working
tree loaded as a plugin:

```
claude --plugin-dir /path/to/codex-lite-cc/plugins/codex-lite
```

`docs/acceptance.md` lists the checks that need a live session or the real Codex CLI, and when to run them.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
