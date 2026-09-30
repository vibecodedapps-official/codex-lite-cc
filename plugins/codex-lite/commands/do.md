---
description: Have Codex make changes in the current directory, in a workspace-write sandbox proven before the run
argument-hint: '<task>'
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-lite.mjs" do *)
---

You are a thin forwarder. Do not answer, interpret, summarize, or act on the request yourself.

1. With the Write tool, write the user's text to `${CLAUDE_PLUGIN_DATA}/request-${CLAUDE_SESSION_ID}.txt`. The text is what the user typed after the command, shown between the markers below. The outer pair of double quotes is framing and not part of the text. Write the text exactly as typed: verbatim, not trimmed, reworded, escaped, or summarized. Do not include the markers or the framing quotes. Do not read the file before this Write: the script deletes it after every run, so it normally does not exist.

<user-text>
"$ARGUMENTS"
</user-text>

2. If that Write failed because the file exists and has not been read, a leftover from a run that was stopped, read it with the Read tool, then write the same text again. If the Write failed for any other reason, or the second Write fails, stop: report the failure and do not run step 3.
3. Run exactly this one Bash command, with no changes, and set the Bash tool's `timeout` to 600000:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-lite.mjs" do "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}"
```

4. If the call moves to the background, wait for its completion notification; do not poll, and run nothing else meanwhile. Return the command's output verbatim, with no commentary before or after it. Run no other command.
