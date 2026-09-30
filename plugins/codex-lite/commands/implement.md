---
description: Have Codex make changes to files, in a workspace-write sandbox proven before the run, and print what it did. Use only when a skill the user invoked delegates a change to Codex as one of its steps. A request typed in plain words, even one that names Codex, is not a delegation: it still goes to /codex-lite:do, which the user must type. Pass the task as the argument. To choose a model, put --model <name> first; to bound how long Codex may take, put --timeout <seconds> (1 to 3600), in either order, each at most once. To run Codex in another checkout, such as a worktree, put --cwd <absolute path> after them, alone on its line, and start the task on the next line: the value is the rest of its line, verbatim, and it must be an existing directory inside a git repository. Every call starts a new Codex thread; there is no --resume. Codex has no network access, and this command forwards the request unchanged, so fetch anything it needs first and name the file in the request. Codex cannot commit; do not run the codex CLI yourself
argument-hint: '[--model <name>] [--timeout <seconds>] [--cwd <absolute path>, last, alone on its line] <task>'
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-lite.mjs" implement *)
---

Steps 1 to 4 forward a request to Codex. Until the output is forwarded, act only as a thin forwarder: do not answer, interpret, summarize, or act on the request yourself.

1. With the Write tool, write the request text to `${CLAUDE_PLUGIN_DATA}/request-${CLAUDE_SESSION_ID}.txt`. The text is the request, shown between the markers below: what the user typed after the command, or the options and task passed when the command is invoked for the user. The outer pair of double quotes is framing and not part of the text. Write the text exactly as given: verbatim, not trimmed, reworded, escaped, or summarized. Do not include the markers or the framing quotes. Do not read the file before this Write: the script deletes it after every run, so it normally does not exist.

<user-text>
"$ARGUMENTS"
</user-text>

2. If that Write failed because the file exists and has not been read, a leftover from a run that was stopped, read it with the Read tool, then write the same text again. If the Write failed for any other reason, or the second Write fails, stop: report the failure and do not run step 3.
3. Run exactly this one Bash command, with no changes, and set the Bash tool's `timeout` to 600000:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-lite.mjs" implement "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}"
```

4. If the call moves to the background, wait for its completion notification; until it arrives, do not poll and use no other tool. Then forward the command's output verbatim, with nothing before it and nothing changed inside it. If the user typed this command, or asked only for Codex's answer or review, that output is your whole reply: add nothing after it, run no other command, and end your turn. If you invoked this command as one step of a larger request, such as a plan to converge or findings to address, continue with that request's remaining steps after the output, using Codex's answer as input.
