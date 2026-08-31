#!/bin/sh
# Cursor waits for beforeSubmitPrompt hooks to exit before it sends the prompt,
# and naming takes several seconds. Hand the payload to a detached renamer instead.
set -eu
payload=$(cat)
# User-level ~/.cursor/hooks.json also fires in the IDE. Name a pane only from a
# Cursor Agent CLI process Herdr is managing. Do not require CURSOR_AGENT: some
# CLI processes never set it, and the hook environment is a merge of process.env
# with a small Cursor-specific map.
[ "${HERDR_ENV:-}" = "1" ] || {
  printf '%s\n' '{"continue":true}'
  exit 0
}
renamer="$HOME/.local/bin/herdr-tab-titles"
[ -x "$renamer" ] || renamer=herdr-tab-titles
printf '%s' "$payload" | nohup "$renamer" --source cursor >/dev/null 2>&1 &
printf '%s\n' '{"continue":true}'
exit 0
