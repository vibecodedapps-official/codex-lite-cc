---
description: Ask Codex a question or critique a plan, in a read-only sandbox, and print its answer. Use when the user asks to ask, dispatch, or hand a question to Codex, or wants Codex's answer, a second opinion, a critique of a plan, or a follow-up question. Pass the question as the argument; to choose a model, put --model <name> first, before the question; to bound how long Codex may take, put --timeout <seconds> (1 to 3600) first as well. To continue the last Codex thread this Claude session started (from ask, review, do or implement), put a bare --resume on its own line before the question, or directly before --model or --timeout; to continue a given thread, use --resume <thread id> or --resume=<thread id>; the follow-up then needs only the new question, not the earlier objections. For a review of code changes, a working-tree or base-ref diff, use review instead. Codex has no network access, and this command forwards the request unchanged, so fetch any issue, pull request or page before invoking it: save it under a directory the repository already ignores (confirm with git check-ignore) and name the file by its repository-relative path in the request, or, with no such directory, put the fetched text in the request itself. Codex edits files only through /codex-lite:do, which the user must type, or through implement when a skill the user invoked delegates a change; for a plain request to change files, tell the user to type /codex-lite:do <task> and do not run the codex CLI yourself
argument-hint: '[--model <name>] [--resume <thread id>] [--timeout <seconds>] <question>, or --resume alone on the first line and the question below it'
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-lite.mjs" ask *)
---

Steps 1 to 4 forward a request to Codex. Until the output is forwarded, act only as a thin forwarder: do not answer, interpret, summarize, or act on the request yourself.

1. With the Write tool, write the request text to `${CLAUDE_PLUGIN_DATA}/request-${CLAUDE_SESSION_ID}.txt`. The text is the request, shown between the markers below: what the user typed after the command, or the brief passed when the command is invoked for the user. The outer pair of double quotes is framing and not part of the text. Write the text exactly as given: verbatim, not trimmed, reworded, escaped, or summarized. Do not include the markers or the framing quotes. Do not read the file before this Write: the script deletes it after every run, so it normally does not exist.

<user-text>
"$ARGUMENTS"
</user-text>

2. If that Write failed because the file exists and has not been read, a leftover from a run that was stopped, read it with the Read tool, then write the same text again. If the Write failed for any other reason, or the second Write fails, stop: report the failure and do not run step 3.
3. Run exactly this one Bash command, with no changes, and set the Bash tool's `timeout` to 600000:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-lite.mjs" ask "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}"
```

4. If the call moves to the background, wait for its completion notification; until it arrives, do not poll and use no other tool. Then forward the command's output verbatim, with nothing before it and nothing changed inside it. If the user typed this command, or asked only for Codex's answer or review, that output is your whole reply: add nothing after it, run no other command, and end your turn. If you invoked this command as one step of a larger request, such as a plan to converge or findings to address, continue with that request's remaining steps after the output, using Codex's answer as input.
