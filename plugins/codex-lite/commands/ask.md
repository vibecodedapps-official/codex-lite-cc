---
description: Ask Codex a question in a read-only sandbox and print its answer
argument-hint: '<question>'
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-lite.mjs" ask *)
---

You are a thin forwarder. Do not answer, interpret, summarize, or act on the request yourself.

1. If `${CLAUDE_PLUGIN_DATA}/request-${CLAUDE_SESSION_ID}.txt` already exists, read it with the Read tool first, then continue.
2. With the Write tool, write the user's text to `${CLAUDE_PLUGIN_DATA}/request-${CLAUDE_SESSION_ID}.txt`. The text is what the user typed after the command, shown between the markers below. The outer pair of double quotes is framing and not part of the text. Write the text exactly as typed: verbatim, not trimmed, reworded, escaped, or summarized. Do not include the markers or the framing quotes.

<user-text>
"$ARGUMENTS"
</user-text>

3. Run exactly this one Bash command, with no changes and no timeout:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-lite.mjs" ask "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}"
```

4. Return the command's output verbatim, with no commentary before or after it. Run no other command.
