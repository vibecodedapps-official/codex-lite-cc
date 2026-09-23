# Acceptance checks

These checks need a live Claude Code session, a real Codex CLI, or both, so the automated
tests cannot run them. Run the per-release list before every version bump, on macOS and on
Windows, and add a row to the record at the end in the same pull request.

Use scratch state throughout: a scratch `CODEX_HOME` holding a copy of your Codex config, a
scratch git repository, and a scratch `CLAUDE_CONFIG_DIR` seeded with a copy of your real
permission rules for the permission items. Give scratch repositories an identity per call
(`git -c user.email=t@example.com -c user.name=t ...`).

## Per release, on each platform

1. **Transport.** Send `/codex-lite:ask` a request containing a double quote, a backtick, a
   command substitution such as `$(id)`, a backslash, a newline and a leading hyphen, and ask
   Codex to echo it back. It must come back byte for byte. Run it in default permission mode
   with your own deny rules in place, and include in the request the name of a flag one of
   those rules matches: the request must still arrive, because it never enters a command
   string. Then create a branch named `topic/$(id)` and run
   `/codex-lite:review --base topic/$(id)`: the ref must reach git as that literal name, with
   nothing executed. The Bash command Claude runs must be the constant one from the command
   file, with no request text in it.
2. **Review.** `review` on a real change returns a review that names a file and a line, and
   changes no files. A base ref that does not exist, a base with no merge base, and a clean
   repository are each refused by the plugin before Codex runs.
3. **Read-only is real.** `ask`, told to write one file in the working directory and one in
   the home directory, is refused both, and neither file exists afterwards. Run it with
   `approvals_reviewer = "auto_review"` in the scratch Codex config; without that setting the
   check proves less.
4. **Write is scoped, and the scope is stated.** From a subdirectory of a repository, `do`
   edits a file there, and the footer's `cwd:` line names that subdirectory, not the
   repository root. From a directory that is not a repository, `do` refuses.
5. **The sandbox probe discriminates.** On a working host all three checks pass and `do`
   runs. In a scratch copy of the plugin loaded with `claude --plugin-dir`, replace the
   probe's runtime (`process.execPath` in the sandbox call) with a path that does not exist:
   the positive control fails and `do` refuses. With `CODEX_LITE_PROBE_TARGET` set to a path
   inside the working directory, the probe refuses rather than passing. On Windows, with no
   `[windows]` `sandbox` value in the scratch Codex config, `setup` says so and `do` refuses
   before the probe. With the value set, the positive control must succeed; if it does not,
   `do` must refuse. Record the Windows result and the value used, including the error code
   name the refusal prints.
6. **The footer is true, checked against the repository and not against itself.** A `do` run
   on a file that was already modified before the run shows that file in the printed tree
   state. A `do` run that writes a file covered by `.gitignore` shows it. A `do` run told to
   commit shows the same value twice on the `HEAD` line, because Codex's sandbox denies writes
   to `.git` and the commit fails. The `requested:` line matches what
   ran, and the printed resume line runs as pasted in a POSIX shell. A run that fails before
   Codex starts a thread prints no resume line.
7. **Codex version drift.** Record `codex --version`. The test suite's fake Codex reproduces
   the JSON event stream of codex-cli 0.155.1. If the installed version differs, re-run items
   2, 3 and 6 against the real CLI and read the output closely, because a change in the
   event format leaves the automated tests green and the plugin broken.
8. **Allow rules match the installed version.** Run `/codex-lite:setup` and check that each
   allow rule it prints matches the paths of the version actually installed, including the
   version number in the plugin path. Paste them into the scratch settings as printed and
   confirm they are valid JSON and match.

## Once, then again only if Claude Code changes the behaviour

These were not run when 0.1.0 was built, because they need an interactive session.

9. **Permission prompts in default mode.** With no allow rules for this plugin, run each
   command once and record which prompts appear: the Read and Write prompts for the request
   file, and whether the Bash call is prompted or pre-approved by the command file's
   `allowed-tools` rule.
10. **Whether the Edit allow rule silences the Write prompt.** Add the Edit allow rule `setup`
    prints for the plugin's data directory, run once with the rule and once without, and
    record whether the Write prompt appears. On Claude Code 2.1.280 it still appears, because
    the file is under `~/.claude`. If that changes, update the Permissions section of the
    README.
11. **Model invocation is refused.** In a fresh session with the plugin installed, ask Claude
    in plain words to run `do` for you. It must not invoke the command, because every command
    file sets `disable-model-invocation: true`. Then ask again in a session where a command
    has already run: Claude may repeat the steps by hand, and its Bash call must be prompted,
    not pre-approved. Deny it.
12. **Deny, then recover, in one session.** Run `/codex-lite:ask` and deny the Bash prompt
    (or, if item 9 found no Bash prompt, interrupt the turn after the Write), then run
    `/codex-lite:ask` again in the same session. The second run must succeed: the command
    file tells Claude to read the leftover request file before writing it again.
13. **A run past two minutes.** Run a `do` or `ask` that takes longer than the Bash tool's
    two-minute default. Confirm the call moves to the background, the run completes, and the
    `requested:` line, the tree state, the thread id and the resume line all reach you
    unaltered through the task notification.
14. **The same long run with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`**, past a short Bash
    timeout. Record whether the script and Codex's process group are gone afterwards. If
    anything survives, the ten-minute cap in the README does not hold for `do`, and a
    surviving `do` run keeps writing with no footer.
15. **Windows install.** On Windows, run `/codex-lite:setup` and `/codex-lite:ask` twice:
    once with only the standalone Codex on `PATH`, and once with only the npm global install
    (`npm install -g @openai/codex`). Record the Codex version `setup` reports each time and
    whether `ask` returns an answer.

## Record

| Date | Version | Platform | Codex version | Result |
| --- | --- | --- | --- | --- |
| 2026-09-23 | 0.1.0 | macOS, Claude Code 2.1.280, headless (`claude -p --plugin-dir`) | codex-cli 0.155.1 | Headless transport check passed: plugin data directory and session id substituted in the command body, a request with a double quote, a backtick, `$(id)`, a backslash, a newline, a leading hyphen and a denied flag name arrived byte for byte (plus one trailing newline the model added), `--base topic/$(id) --model x` arrived byte for byte with nothing executed. Items 1 to 15 not yet run. |
| 2026-09-23 | 0.2.0 | Windows 11 Pro 10.0.26200, entry script run directly with `node` (no Claude Code session) | codex-cli 0.156.1 standalone; codex-cli 0.154.0 from `npm install -g @openai/codex` (package 0.154.0) | Item 15 in part: with each install as the only Codex on `PATH`, `setup` reported its version and login, and `ask` returned an answer. On both, the sandbox probe's positive control failed (exit 42, EPERM), so `do` refuses on this host. Items 1 to 14 not run; macOS not run for this version. |
| 2026-09-23 | 0.2.0 | macOS 27.0, Claude Code 2.1.280; entry script run directly with `node`, plus headless `claude -p --plugin-dir --permission-mode default` for items 1 and 8, with the real Claude config dir and `--settings` (a scratch `CLAUDE_CONFIG_DIR` had no login) | codex-cli 0.156.1 | Items 2 to 7 passed with the real CLI and no `unparseable stream lines`, except the commit case in item 6: Codex's sandbox denied `.git/index.lock`, so `do` cannot commit and the two-`HEAD` check was not reached. Item 3 used `approvals_reviewer = "auto_review"` in the scratch config, but the plugin passes `--ignore-user-config`, so the setting may not have applied. Item 1 in part: the Write of the request file was blocked as "a sensitive file" (it is under `~/.claude`), even with the Edit allow rule from `setup` and an explicit Write allow rule. The Bash command Claude then ran was the constant one, pre-approved and without request text. The request Claude tried to write was byte for byte the typed text, including a denied flag name; sent through the entry script, Codex echoed it byte for byte plus one trailing newline. `--base topic/$(id)` reached git as that literal name. Item 8 not confirmed: the rules name the `--plugin-dir` path, which has no version number; the Edit rule did not unblock the Write, and the Bash rule was not exercised because `allowed-tools` already pre-approves the call. Items 9 to 14 are in the next row; item 15 is Windows only. |
| 2026-09-23 | 0.2.0 | macOS 27.0, Claude Code 2.1.280, interactive session in `--permission-mode default` with `--plugin-dir` and the real Claude config dir | codex-cli 0.156.1 | Item 9: `setup` showed no prompt. `ask`, `review` and `do` each showed a Read prompt for the request file (Claude read it even when it did not exist), then a Write prompt; the Bash call was pre-approved by `allowed-tools`. Item 10 failed: with the Edit allow rule from `setup` in `--settings`, the Write prompt still appeared. The prompt's own option to allow edits in `~/.claude` for the session does silence it. Item 11 passed in a fresh session: Claude did not invoke the command, searched `PATH` for a `codex-lite` program and offered other options. In a session where the commands had already run, Claude instead repeated the command file's steps by hand; its Bash call was then prompted, not pre-approved, and was denied. Item 12 passed: after an interrupt that left the request file behind, the next `ask` read it, overwrote it and answered. Item 13 passed for `ask` and for `do`: each moved to the background at 120 s, and the `requested:` line, the tree state, the thread id and the resume line arrived intact in the notification. Item 14 passed: with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` and `BASH_DEFAULT_TIMEOUT_MS=30000`, a `do` running `sleep 90` timed out at 30 s; within 15 s the script, `codex exec` and the `sleep` were gone, and the file edit that was due after the sleep never happened. |
| 2026-09-23 | 0.2.1 | Windows 11 Pro 10.0.26200, entry script run directly with `node` (no Claude Code session) | codex-cli 0.156.1 standalone | Item 5 in part. With no `[windows]` `sandbox` value, `setup` reported it as not set, and a direct `codex sandbox` write inside the working directory was denied (exit 42, EPERM). With a scratch `CODEX_HOME` set to `"unelevated"`, and then to `"elevated"`, `setup` proved `workspace-write`: the inside write landed and the outside write was denied (EPERM). With `"elevated"`, `do` ran a shell command end to end and the file it wrote appeared in the tree. With `"unelevated"`, a direct `codex exec` could not start Codex's shell, PowerShell 7 from the Microsoft Store ("CreateProcessAsUserW failed"). Without the value, `codex exec` in `workspace-write` rejected commands with "blocked by policy". Items 1 to 4 and 6 to 15 not run. |
| 2026-09-23 | 0.2.1 | macOS 27.0, Claude Code 2.1.280, Node 26.4.0; plugin copied to a scratch path shaped like the install cache (`.../codex-lite/0.2.1`); entry script run directly with `node`, plus headless `claude -p --permission-mode default` for items 1 and 8 with the real Claude config dir | codex-cli 0.156.1 | `npm test` (88 pass, 8 skipped) and `npm run lint` pass. `setup` shows no Windows sandbox row, and no `requested:` or `Resume:` line carries a `windows.sandbox` flag. Items 2 to 7 passed with the real CLI and no `unparseable stream lines`. Item 6 now reaches the commit case: the commit failed on `.git/index.lock` ("Operation not permitted") and the `HEAD` line showed `6098cde` twice. A pasted resume line ran in `sh` and answered. A wrapper around Codex confirmed the `requested:` line matches the argv Codex received. Item 5: with the probe's runtime replaced by a missing path, the positive control failed with exit 71 (`execvp()` failed), and `setup` and `do` both refused, but the message blames Codex's sandbox for what is a missing runtime. Item 3 again used `approvals_reviewer = "auto_review"` in the scratch config, which `--ignore-user-config` may drop. Item 1 in part, as for 0.2.0: in `default` and in `acceptEdits` mode the Write of the request file was blocked as "a sensitive file", and Claude then did not run the Bash command. The Write's content was byte for byte the typed text, including a denied flag name. Sent through the entry script, Codex echoed that text byte for byte, and `--base topic/$(id)` reached Codex as that literal name. Item 8 passed for the Bash rule: both printed rules parse as a JSON array. Asked to run the `setup` command by hand with no plugin loaded, Claude was denied without the rules and ran it with them, so the `*` matches the version directory. That `*` also let a sibling directory (`codex-lite-other/scripts/...`) and a path through `..` run unprompted, so the rule now names the exact version path; rerun the same way, it ran the installed path and was denied both others. The Edit rule was pasted but not exercised; item 10 in the 0.2.0 row covers it. Items 9 to 14 not rerun: Claude Code is unchanged since the 0.2.0 run, and the `ask`, `review` and `do` command files are unchanged from 0.2.0, so the Claude side of item 1 and items 9 to 14 stand on the 0.2.0 rows. Item 15 is Windows only. |
