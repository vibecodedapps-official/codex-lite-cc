---
description: Check the Codex CLI version, login, Windows sandbox mode, and write sandbox, and print the allow rules for this plugin
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-lite.mjs" setup *)
---

Run exactly this one Bash command, with no changes and no timeout:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-lite.mjs" setup "${CLAUDE_PLUGIN_DATA}"
```

Return its output verbatim inside a fenced code block, with no commentary before or after it. Outside a code block, Markdown drops the backslashes the allow rules need. Run no other command and change no settings.
