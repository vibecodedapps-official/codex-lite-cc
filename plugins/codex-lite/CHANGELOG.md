# Changelog

## 0.9.0 - 2026-09-30

- `/codex-lite:review` takes `--cwd <absolute path>`, as `--cwd <path>` or `--cwd=<path>`,
  on its own line as the last line of the request, with the value rule of `implement`: the
  rest of the line, verbatim, trailing spaces and tabs dropped. The path must be absolute and
  an existing directory inside a git repository, or the command refuses before Codex runs.
  Codex runs read-only from the top of that repository and the `cwd:` line shows it. This
  serves reviews of a checkout that is not the session's directory, such as a worktree.
  A `--cwd` anywhere but the last line, or given twice, is refused. Requests without `--cwd`
  parse as before.

## 0.8.0 - 2026-09-30

- New command `/codex-lite:implement`, which Claude may invoke. It runs the same
  `workspace-write` turn as `do`, after the same sandbox probe, and prints the same `requested:`,
  `cwd:` and `sandbox:` lines, `HEAD` and tree-state footer, thread line, `Resume:` line and
  `status:` line. Its description says Claude may invoke it only when a skill the user invoked
  delegates a change to Codex as one of its steps; a request typed in plain words, even one
  that names Codex, still goes to `/codex-lite:do`. It takes three leading options: `--model <name>`, `--timeout <seconds>`
  (1 to 3600) and `--cwd <absolute path>`. `--model` and `--timeout` go first in any order,
  each at most once. `--cwd`, as `--cwd <path>` or `--cwd=<path>`, is last: its value is the
  rest of its line, verbatim, so a path with spaces or Windows backslashes is carried intact,
  and the task starts on the next line. A `--model`, `--timeout` or second `--cwd` directly
  after the `--cwd` line is refused. The path must be absolute and an existing directory inside
  a git repository, or the command refuses before Codex runs; Codex runs there and its write
  sandbox is bounded to it, while the tree footer stays repository-wide, as for `do`. This
  serves runs whose checkout is not the session's directory, such as a worktree. It also
  means the invoking skill chooses the repository Codex writes in: any git checkout on disk
  is accepted, and the README says so. Trailing spaces and tabs on the `--cwd` line are
  dropped. There is no
  `--resume`: every call starts a new thread, whose id is saved as for `do`, so `ask --resume`
  can question it read-only. A `--resume` in the text is task text, and an empty task is
  refused. `do` is unchanged: hidden from Claude, typed by the user, no options.
- This weakens one guarantee: writes were gated on a command only you could type, and a skill
  can now delegate a change through `implement`. In default permission mode the Skill call
  still prompts. The README states the tradeoff.
- The `UserPromptSubmit` hook's routing note gains one clause: a skill that delegates
  implementation to Codex uses `implement`, and a plain request to change files still goes to
  `/codex-lite:do`.
- The `ask` and `review` descriptions now say a skill may delegate a change through
  `implement`. Before, they said Codex edits files only through `/codex-lite:do`, which the
  user must type.
- `npm run lint` applies the command-file checks to `implement.md`: no
  `disable-model-invocation`, the Write first, the Read only after a failed Write, and a step 4
  identical to `ask` and `review`.

## 0.7.2 - 2026-09-30

- The `ask`, `review` and `do` command files start with the Write of the request file and
  read it only when that Write fails on a leftover file. Any other failed Write, or a failed
  second Write, stops the command before the script runs, so a leftover request, possibly an
  earlier task, is never sent to Codex. Before, step 1 told Claude to read
  the file first if it existed, which Claude cannot tell without a tool call, and the script
  deletes the file after every run, so almost every call began with a failed Read.
- The `UserPromptSubmit` hook's routing note says options go before the question in any
  order, and that `--resume` takes a thread id or, bare, is followed by a line break or
  another option. Before, it said to put `--model` first and also to put `--resume` first,
  on its own line, which contradicted itself and read as stricter than the parser: a
  `--resume <thread id>` on the same line as the question was always accepted.

## 0.7.1 - 2026-09-29

- The `ask` and `review` command files now say what Claude does after forwarding Codex's
  output. When you type the command, or ask Claude only for Codex's answer, the output is the
  whole reply and the turn ends, as before. When Claude invoked the command as one step of a
  larger request, it forwards the output verbatim and then continues that request using
  Codex's answer. Before, the text said to add nothing and run no other command in every
  case, which could read as ending the turn in the middle of a larger request.

## 0.7.0 - 2026-09-28

- The `UserPromptSubmit` hook adds no routing note to a prompt that starts with any slash
  command, whichever plugin it belongs to; a prompt that starts with an absolute path is not
  a command and still gets the note. Before, only a prompt starting with `/codex-lite:`
  was skipped, so a command such as `/other:run --no-codex` got the note in its context.
- `review --base <ref>` checks for changes the way Codex reviews them: the net difference from
  the merge base of the base and `HEAD` to the working tree, tracked files only. A base equal
  to `HEAD` with a modified tracked file or a staged new file is now reviewed, and the refusal
  says untracked files are not compared. Before, the plugin compared the base with `HEAD` only
  and refused, as "nothing to review", changes Codex would have reviewed.
- Every `ask`, `review` and `do` result ends with one line, `status: ok`, `status: refused`,
  `status: timeout` or `status: failed`, after the resume line and after any refusal. The
  word is decided by phase: `refused` before the task turn is attempted, `timeout` or
  `failed` once it is, `ok` only when the run and its reporting completed. A result with no
  status line was cut off; an unexpected error in the plugin itself is `failed` in either
  phase. `setup`, the hook and an unknown command print none. Before, a
  caller had to read the prose to tell a refusal from a timeout from a Codex failure.
- On `ask`, a CRLF line ending after `--model <name>` or `--timeout <seconds>` is consumed
  whole, as it already was after a bare `--resume`. Before, `--model x` followed by CRLF left
  a newline at the start of the question, so a request file with Windows line endings sent
  Codex a question with a leading blank line.
- `review` refuses a repeated `--base` or `--model`, as it does a repeated `--timeout` and as
  `ask` always has. Before, the last value won silently, so a call that appended `--base`
  twice reviewed against the wrong base without notice.
- `ask` and `review` take `--timeout <seconds>` or `--timeout=<seconds>`, a whole number from
  1 to 3600, at most once, which replaces the sixty-minute limit on the Codex turn for that
  call. On `ask` it is a leading flag next to `--model` and `--resume`, in any order. It
  bounds the turn only, not the local checks before it, and is not passed to Codex. `do` has
  no such flag. Before, the only override was a test-only environment variable, which a
  caller could not pass per call.
- The README says the plugin supports one call at a time per Claude session: two concurrent
  calls in one session share the request file and the saved thread file. Before, it did not
  say.

## 0.6.0 - 2026-09-26

- `ask` takes `--resume <thread id>`, `--resume=<thread id>`, or a bare `--resume` on its own
  line to continue a Codex thread instead of starting a new one. Resume always runs
  `read-only`, whatever sandbox the original run used, and the follow-up needs only the new
  question, not the earlier objections restated by hand. The bare form continues the last
  thread this Claude session started, from `ask`, `review` or `do`: the plugin saves that
  thread's id, per session, after every successful run, and refuses the bare form before Codex
  runs when nothing is saved yet. Codex's own `--last` is not used for this, because it picks
  the newest session for the working directory, which can belong to another Claude session.
  Before, every `ask` started a new thread, and a multi-round review needed the earlier
  objections pasted back into each new question.
- The `UserPromptSubmit` hook's routing note now also tells Claude to put `--resume` first, on
  its own line, for a follow-up in the same Codex thread. Before, the note said nothing about
  resuming.

## 0.5.0 - 2026-09-26

- `ask` and `review` run from the top of the repository, whatever directory the shell is in.
  Before, they ran from the shell's current directory, so a shell left in a subdirectory
  changed where Codex ran, and a relative path in the question could point at the wrong
  file. `do` still runs from the shell's directory, which bounds where it can write.
- `ask` and `review` print `network: none in the read-only sandbox`, and their descriptions
  say Codex cannot fetch issues, pull requests or pages, so the caller fetches them before
  invoking `ask`: into a file under an ignored directory, named by its repository-relative
  path, or into the request itself when there is no such directory. A typed command forwards
  the request unchanged, so its context must be ready first. Before, a `gh issue view`
  inside Codex failed, and Codex could fall back to older copies it found in the repository.
- The command files set the Bash tool's timeout to ten minutes and say to wait for the
  background notification. Before, they said to run with no timeout, which the Bash tool
  cannot do: it used its two-minute default.

## 0.4.0 - 2026-09-26

- A `UserPromptSubmit` hook adds a routing note to Claude's context when a prompt mentions
  Codex: `ask` for questions, plan critiques and second opinions, `review` only for
  working-tree or base-ref diffs, a model choice first as `--model <name>`, file changes
  through `/codex-lite:do`, and no direct Codex runs. Before, a request such as "review this
  plan with codex" could go to `review`, which reviews a diff, or to the Codex CLI directly.
  A prompt that starts with `/codex-lite:` gets no note. The note is guidance, not
  enforcement.
- `ask` takes an optional leading `--model <name>` or `--model=<name>`, passed to Codex as
  `--model`. Only the question after it is sent. A `--model` later in the question is
  question text. Before, `ask` always ran on Codex's default model.
- The `ask` and `review` descriptions now say which one takes plan critiques and which takes
  diffs.
- The README documents an optional `Bash(codex *)` deny rule against direct Codex runs, and
  what it does not cover.

## 0.3.0 - 2026-09-25

- `ask` and `review` no longer set `disable-model-invocation`, so Claude can see them and
  invoke them when asked in plain words, such as "dispatch Codex to review this". Before,
  every command was hidden from Claude, and a plain-words request ran the Codex CLI directly
  or nothing at all. Their descriptions now name those phrases. This is new: until now every
  Codex run started with a typed command, and now a `review` or `ask` can start from Claude's
  own reading of a request. In auto mode it runs with no approvals. In default mode Claude
  Code asks before running the command, before writing the request file, and before the
  script call. `do` and `setup` stay hidden and run only when typed. Asked in plain words to
  have Codex change files, Claude now tells you to type `/codex-lite:do <task>`. Before, in
  auto mode, it ran the Codex CLI with write access itself, without the plugin's checks.
- On Windows, the Bash allow rule `setup` prints now writes the plugin path with forward
  slashes. Before, its backslashes never matched the command Claude Code runs, so the rule
  did not stop the prompt.

## 0.2.1 - 2026-09-23

- On Windows, Codex's sandbox denies every write and every command unless its Windows
  sandbox mode is set, and `--ignore-user-config` dropped the user's setting. So `do` could
  not run, and `ask` and `review` could not run commands. The plugin now reads the
  `[windows]` `sandbox` value (`"unelevated"` or `"elevated"`) from your Codex config and
  passes it as `-c windows.sandbox="<value>"` on every run, probe and resume line. When it is
  not set, `do` refuses and says what to add, `ask` and `review` warn, and `setup` reports
  it.
- The sandbox probe no longer says the host cannot sandbox when the positive control fails.
- `setup` prints the allow rules as JSON strings, ready to paste into `permissions.allow`.
  The Bash rule names the installed version's exact path, so update it after each release;
  until then Claude asks again. A `*` in the path would also match another plugin's
  directory or a path through `..`.
- `setup` returns its output in a code block. Before, Claude Code's Markdown dropped the
  backslashes from the printed Bash rule, so on Windows it was not valid JSON.
- The Windows sandbox mode is read correctly when it is set in an inline table whose other
  values contain a brace or comma, and when the `windows` key is single-quoted. Before, `do`
  refused on Windows as if the mode were not set, and a mode written inside another string
  value was taken as the setting.

## 0.2.0 - 2026-09-23

- On Windows, the npm global install of Codex (`npm install -g @openai/codex`) now works.
  Before, the plugin refused to run when only its `codex.cmd` was on `PATH`. The plugin
  runs the `codex.exe` inside the npm package directly, so it still starts Codex without a
  shell. A `codex.exe` on `PATH` is still used first. Installs made with pnpm, bun or
  other package managers are refused with a message that says so.

## 0.1.0 - 2026-09-23

First release.

- `/codex-lite:ask` sends a question to Codex in a read-only sandbox and prints the answer.
- `/codex-lite:review` reviews uncommitted changes, or the diff against `--base <ref>`,
  read-only, with an optional `--model <name>`. It refuses a base ref that does not exist, a
  base with no merge base, and an empty diff before Codex runs.
- `/codex-lite:do` lets Codex change files in the current directory under a
  `workspace-write` sandbox. Before each run it checks that the sandbox really blocks a write
  outside the directory, and after the run it prints `HEAD` before and after and the state of
  the working tree.
- `/codex-lite:setup` reports the Codex version, the login state and the sandbox check, and
  prints the allow rules you can add yourself. It changes no settings.
- Every result names the exact Codex command that ran and, when Codex started a thread,
  prints a read-only `codex exec resume` line you can paste into a terminal.
- A run is stopped after sixty minutes. On macOS and Linux, anything Codex leaves running
  in the background is stopped when it exits.
- Requires Node 22 or later. Windows is supported in the code but has not been tested by
  hand.
