# Contributing

## Working on it

Link a checkout instead of installing from GitHub, and run the installer yourself, because `link` does not run
build commands:

```sh
herdr plugin link .
node scripts/install.mjs
```

Herdr then runs `src/rename.mjs` straight out of the working tree, and re-reads `herdr-plugin.toml` from disk, so
edits to either apply with nothing else to do. Re-run `node scripts/install.mjs` after changing the Pi extension,
the Claude Code, Codex, Cursor Agent CLI, or OpenCode hook, or the shell process hook, though: those are copied
into `~/.pi`, `~/.local/bin`, `~/.codex`, `~/.claude`, `~/.cursor`, `~/.config/opencode`, and
`~/.local/share/herdr-tab-titles` rather than read live.

## Tests

```sh
node --test test/*.test.mjs
```

The tests cover the pure functions: label parsing, first-prompt title gating, generator resolution,
worktree formatting, the pane cap, the kind placeholder applied on `pane.agent_detected`,
clearing that name when the agent is released, and foreground-process labels.
Runtime tests drive `src/rename.mjs` with fake Herdr and generator binaries for failure,
timeout, retry, and status paths. Installer tests use a temporary home.
Everything else needs a running Herdr, so exercise it by prompting a real agent and reading the log:

```sh
tail -f ~/.local/state/herdr/plugins/tab-titles/rename.log
herdr plugin action invoke status --plugin tab-titles
```

Renames run detached. A failure never reaches the UI, so that log and the `lastError` field in `status` are the
only places a broken generator shows up.

## Title-generation eval

Run the Promptfoo golden-output evaluation after changing the title prompt, parser, default model, or generator
invocation:

```sh
npm run eval:titles
```

The custom provider in `eval/title-provider.mjs` calls the plugin's production generation function. It reads
the plugin config (`herdr plugin config-dir tab-titles`, file `tab-titles.json`) and invokes the configured Pi or Claude CLI with its existing local login.
Promptfoo checks the trimmed raw model response before `parseLabel` can repair Markdown, list markers, or added
commentary, so the eval measures whether the generation prompt itself does its job. It uses no API token, cloud
sharing, model-based grader, or second provider. Its exact-match cases are the expected title examples in
`eval/title-cases.yaml`, with an additional local assertion for the 2-5 word, 40-character, single-title format.

Results are intentionally uncached and calls run serially. To check whether a nondeterministic model is consistent,
repeat every case explicitly:

```sh
npm run eval:titles -- --repeat 3
```

Promptfoo is version-pinned in `package.json` and downloaded through `npx`, so it does not add runtime dependencies
to the plugin. The eval requires Node.js 22.22 or newer plus whichever authenticated CLI the plugin configuration
selects. A failed golden case makes the command exit nonzero.

## Label parsing

`parseLabel` is deliberately forgiving, because models ignore the system prompt in ways that are easier to absorb
than to prevent. Every branch in it exists because a real model produced that output. When a new failure appears,
add the exact text to `test/rename.test.mjs` rather than a paraphrase of it.

## Machine-specific settings

Nothing about a particular machine belongs in this repository. Generators, models, and executable paths go in
the plugin config directory (`herdr plugin config-dir tab-titles`), which is how one laptop can name tabs with Pi and another with Claude.
