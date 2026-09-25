# Changelog

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
