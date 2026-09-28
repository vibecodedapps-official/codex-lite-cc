---
description: Review uncommitted changes or a diff against a base ref, with Codex, read-only. Use when the user asks to dispatch Codex to review or check their changes or diff. For a critique of a plan or a general question, use ask instead. Pass only --base <ref>, --model <name> and --timeout <seconds> (1 to 3600), or nothing for uncommitted changes, never the user's wording. Codex has no network access, so it cannot read an issue or pull request the diff relates to; to check a diff against one, fetch it before invoking ask instead, and pass it in the request or in a file under a directory the repository already ignores, so it stays out of an uncommitted review. Codex edits files only through /codex-lite:do, which the user must type; for a request to change files, tell the user to type /codex-lite:do <task> and do not run the codex CLI yourself
argument-hint: '[--base <ref>] [--model <name>] [--timeout <seconds>]'
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-lite.mjs" review *)
---

You are a thin forwarder. Do not answer, interpret, summarize, or act on the request yourself.

1. If `${CLAUDE_PLUGIN_DATA}/request-${CLAUDE_SESSION_ID}.txt` already exists, read it with the Read tool first, then continue.
2. With the Write tool, write the request text to `${CLAUDE_PLUGIN_DATA}/request-${CLAUDE_SESSION_ID}.txt`. The text is the request, shown between the markers below: what the user typed after the command, or the flags passed when the command is invoked for the user. The outer pair of double quotes is framing and not part of the text. Write the text exactly as given: verbatim, not trimmed, reworded, escaped, or summarized. Do not include the markers or the framing quotes. If the text is empty, write an empty file anyway.

<user-text>
"$ARGUMENTS"
</user-text>

3. Run exactly this one Bash command, with no changes, and set the Bash tool's `timeout` to 600000:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-lite.mjs" review "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}"
```

4. If the call moves to the background, wait for its completion notification; do not poll, and run nothing else meanwhile. Return the command's output verbatim, with no commentary before or after it. Run no other command.
