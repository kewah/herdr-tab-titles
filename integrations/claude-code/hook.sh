#!/bin/sh
# Claude Code waits for UserPromptSubmit hooks to exit before it sends the prompt,
# and naming takes several seconds. Hand the payload to a detached renamer instead.
set -eu
# Name a pane only from a person's own session. `claude --print` reports sdk-cli,
# and a script calling it inside a pane would otherwise rename that pane.
case "${CLAUDE_CODE_ENTRYPOINT:-}" in
  sdk*) exit 0 ;;
esac
renamer="$HOME/.local/bin/herdr-tab-titles"
[ -x "$renamer" ] || renamer=herdr-tab-titles
payload=$(cat)
printf '%s' "$payload" | nohup "$renamer" --source claude-code >/dev/null 2>&1 &
exit 0
