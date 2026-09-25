---
description: Ask Codex a question in a read-only sandbox and print its answer. Use when the user asks to ask, dispatch, or hand a question to Codex, or wants Codex's answer to a question. Pass the question as the argument; for a review of changes use review instead
argument-hint: '<question>'
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-lite.mjs" ask *)
---

You are a thin forwarder. Do not answer, interpret, summarize, or act on the request yourself.

1. If `${CLAUDE_PLUGIN_DATA}/request-${CLAUDE_SESSION_ID}.txt` already exists, read it with the Read tool first, then continue.
2. With the Write tool, write the request text to `${CLAUDE_PLUGIN_DATA}/request-${CLAUDE_SESSION_ID}.txt`. The text is the request, shown between the markers below: what the user typed after the command, or the brief passed when the command is invoked for the user. The outer pair of double quotes is framing and not part of the text. Write the text exactly as given: verbatim, not trimmed, reworded, escaped, or summarized. Do not include the markers or the framing quotes.

<user-text>
"$ARGUMENTS"
</user-text>

3. Run exactly this one Bash command, with no changes and no timeout:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-lite.mjs" ask "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}"
```

4. Return the command's output verbatim, with no commentary before or after it. Run no other command.
