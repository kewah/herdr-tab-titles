# Tab Titles

A [Herdr](https://herdr.dev) plugin that names panes and tabs after the first prompt you give a coding agent.

For people who run **Pi**, **Codex**, **Claude Code**, **Cursor Agent CLI**, or **OpenCode** inside Herdr and want the tab bar to show the task, not `Claude Code` or `3`. Panes with no chat are named after the foreground process (`nvim`, `git`, `bash`).

```
Before:  3  Claude Code     Pi              bash
After:   3  README update   Fix OAuth       nvim
```

## Install

```sh
herdr plugin install kewah/herdr-tab-titles
```

Then `/reload` running Pi sessions, or restart Codex, Claude Code, Cursor Agent CLI, and OpenCode. Codex will ask you to trust the new hook; approve `herdr-tab-titles --source codex`. Process names need a new shell, or `source ~/.bashrc` / `~/.zshrc`.

The installer wires whichever of those agents it finds. It is idempotent, backs up files it rewrites, and does not replace unrelated hooks (including Herdr's Cursor `sessionStart` entry).

**Requires:** [Herdr](https://github.com/herdrdev/herdr) 0.8+, Node.js 22.22+, Linux or macOS, and **Pi** already signed in for zero-config title generation. Claude-only machines must create the config below with `"generator": "claude"`. The chosen CLI is used only to mint the short title.

## What to expect

- Agent appears → pane is labeled `Claude Code`, `Pi`, `Codex`, …
- First prompt → a 2–4 word task title replaces that label (pane and, by default, the tab)
- Later prompts keep the same title
- Agent leaves → names fall back to another titled pane in the tab, the process, or Herdr's tab number
- No agent → pane follows the foreground process

Each pane gets its own label. A tab has one shared label, so it follows the pane that most recently received its first prompt. Manual pane labels are replaced by that first prompt.

**Not this:** it does not rename chats inside the agent UIs, and it is not a Herdr theme or layout. Headless runs (`claude --print`, Pi/Cursor/OpenCode non-interactive modes) do not rename; `codex exec` currently can.

If a title never appears, generation, Herdr metadata, or a pane/tab rename may have failed. A failed generation is retried on the next prompt using the original first message. `rename-now` still forces a new title from the pane's current contents:

```sh
herdr plugin action invoke status --plugin tab-titles
```

That prints the resolved command (or a config/state error) and the last error. Pane records omit the raw first prompt. Detail is also in `~/.local/state/herdr/plugins/tab-titles/rename.log`. Confirm Pi (the default) with:

```sh
pi --print --no-session --no-tools --no-extensions --model openai-codex/gpt-5.6-luna:minimal "say hi"
```

## Update

An install is pinned to a commit. Reinstall over the top, then restart (or `/reload`) running agents:

```sh
herdr plugin install kewah/herdr-tab-titles
herdr plugin list --plugin tab-titles --json
```

`source.resolved_commit` is what is running.

## Configuration

Optional, machine-local. Herdr injects `HERDR_PLUGIN_CONFIG_DIR` when it runs the plugin. Print that directory with:

```sh
herdr plugin config-dir tab-titles
```

On Linux that is `~/.config/herdr/plugins/config/tab-titles/` (or `$XDG_CONFIG_HOME/herdr/plugins/config/tab-titles/`). Put `tab-titles.json` there. Runtime state and `rename.log` live under `~/.local/state/herdr/plugins/tab-titles/` (or `$XDG_STATE_HOME/herdr/plugins/tab-titles/`). There is no `herdr plugin state-dir` command in Herdr 0.8; hooks without the injected env vars use the same fallback.

If you already had `~/.config/herdr/tab-titles.json` or `~/.local/state/herdr-tab-titles/state.json`, the plugin copies them into the Herdr directories once when the new files are absent, and leaves the old files in place.

Use the CLI this machine is already signed into. Default generator is Pi with `openai-codex/gpt-5.6-luna:minimal`.

```json
{
  "generator": "pi",
  "model": "openai-codex/gpt-5.6-luna:minimal",
  "timeoutMs": 60000,
  "renameTab": true
}
```

Claude CLI instead:

```json
{
  "generator": "claude",
  "model": "haiku",
  "timeoutMs": 60000,
  "renameTab": true
}
```

`generator` is `pi` or `claude`. `model` is passed through to that CLI (Claude aliases such as `haiku` work). Optional `piPath` / `claudePath` override the executable when it is not on the plugin's `PATH`. Set `renameTab` to `false` to leave tab labels alone.

## Commands

```sh
herdr plugin action invoke status --plugin tab-titles
herdr plugin action invoke rename-now --plugin tab-titles
```

`rename-now` regenerates the title of the pane focused in the Herdr UI (not necessarily the pane you invoked it from). That is the opt-in exception to first-prompt-only. Transient generation failures retry automatically on the next prompt and reuse the original first message.

## Sidebar (optional)

To show compact Git context instead of Herdr's workspace label:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "pane"],
  ["$worktree"],
]
```

The plugin refreshes `$worktree` as `project · branch` or `worktree · branch` on each prompt.

## From a checkout

`herdr plugin link` does not run the installer:

```sh
git clone https://github.com/kewah/herdr-tab-titles
herdr plugin link herdr-tab-titles
node herdr-tab-titles/scripts/install.mjs
```

A linked tree is live for `src/rename.mjs`. Re-run the installer after changing an agent or shell hook; those copies live under `~/.pi`, `~/.local/bin`, `~/.codex`, `~/.claude`, `~/.cursor`, `~/.config/opencode`, and `~/.local/share/herdr-tab-titles`.

## Files

| Path | Role |
| --- | --- |
| `~/.config/herdr/plugins/config/tab-titles/tab-titles.json` | Optional config (`herdr plugin config-dir tab-titles`) |
| `~/.local/state/herdr/plugins/tab-titles/` | State and `rename.log` |
| `~/.local/bin/herdr-tab-titles` | Launcher |
| `~/.local/bin/herdr-tab-titles-hook` | Claude Code wrapper |
| `~/.local/bin/herdr-tab-titles-cursor-hook` | Cursor Agent CLI wrapper |
| `~/.pi/agent/extensions/herdr-tab-titles.ts` | Pi |
| `~/.codex/hooks.json` | Codex |
| `~/.claude/settings.json` | Claude Code |
| `~/.cursor/hooks.json` | Cursor Agent CLI |
| `~/.config/opencode/plugins/herdr-tab-titles.js` | OpenCode |
| `~/.local/share/herdr-tab-titles/hook.{bash,zsh}` | Process names |

## License

[MIT](LICENSE)
