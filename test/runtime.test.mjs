import assert from "node:assert/strict";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createHarness,
  loggedCommands,
  matchingCommands,
  promptPayload,
  readState,
  removeHarness,
  runNode,
  runRename,
  writeJson,
  writeState,
  RENAME_PATH,
} from "./helpers.mjs";

async function withHarness(options, fn) {
  const harness = await createHarness(options);
  try {
    return await fn(harness);
  } finally {
    await removeHarness(harness);
  }
}

test("retries generation on the next prompt using the original titlePrompt", async () => {
  await withHarness({}, async (harness) => {
    await writeFile(join(harness.piDir, "fail-left"), "1\n");
    const first = await runRename(harness, {
      args: ["--source", "pi"],
      env: { HERDR_PANE_ID: "w1:p2", HERDR_TAB_ID: "w1:t1" },
      input: promptPayload("SECRET original prompt", harness.root),
    });
    assert.equal(first.code, 0);
    const failed = await readState(harness);
    assert.equal(failed.panes["w1:p2"].titlePrompt, "SECRET original prompt");
    assert.equal(failed.panes["w1:p2"].pending, undefined);
    assert.equal(failed.panes["w1:p2"].label, undefined);
    assert.match(failed.lastError.message, /generator failed|exited 1/);

    const second = await runRename(harness, {
      args: ["--source", "pi"],
      env: { HERDR_PANE_ID: "w1:p2", HERDR_TAB_ID: "w1:t1" },
      input: promptPayload("a later unrelated prompt", harness.root),
    });
    assert.equal(second.code, 0);
    const stdin = await readFile(join(harness.piDir, "stdin.txt"), "utf8");
    assert.match(stdin, /SECRET original prompt/);
    assert.doesNotMatch(stdin, /later unrelated prompt/);
    const state = await readState(harness);
    assert.equal(state.panes["w1:p2"].label, "Fix OAuth redirect");
    assert.equal(state.panes["w1:p2"].titlePrompt, undefined);
    const commands = await loggedCommands(harness);
    assert.ok(matchingCommands(commands, "pane", "rename").some((argv) => argv[3] === "Fix OAuth redirect"));
  });
});

test("falls back to the standby generator when the primary fails", async () => {
  await withHarness({ config: { fallback: true } }, async (harness) => {
    await writeFile(harness.configPath, `${JSON.stringify({
      generator: "pi",
      piPath: harness.piPath,
      claudePath: harness.claudePath,
      timeoutMs: 5_000,
      renameTab: true,
    }, null, 2)}\n`);
    await writeFile(join(harness.piDir, "fail-left"), "1\n");
    const result = await runRename(harness, {
      args: ["--source", "pi"],
      env: { HERDR_PANE_ID: "w1:p2", HERDR_TAB_ID: "w1:t1", FAKE_PI_LABEL: "Fix OAuth redirect" },
      input: promptPayload("wire up the oauth callback", harness.root),
    });
    assert.equal(result.code, 0);

    const state = await readState(harness);
    const record = state.panes["w1:p2"];
    assert.equal(record.label, "Fix OAuth redirect");
    assert.equal(record.generator, "claude");
    assert.equal(record.model, "haiku");
    assert.equal(state.lastError, undefined);

    const claudeStdin = await readFile(join(harness.claudeDir, "stdin.txt"), "utf8");
    assert.match(claudeStdin, /wire up the oauth callback/);
    const claudeArgv = JSON.parse(await readFile(join(harness.claudeDir, "argv.txt"), "utf8"));
    assert.deepEqual(claudeArgv.slice(0, 5), ["--print", "--no-session-persistence", "--tools", "", "--model"]);
    assert.equal(claudeArgv[5], "haiku");

    const renames = matchingCommands(await loggedCommands(harness), "pane", "rename");
    assert.ok(renames.some((argv) => argv.includes("Fix OAuth redirect")));

    const log = await readFile(join(harness.stateDir, "rename.log"), "utf8");
    assert.match(log, /fell back to claude after pi failed/);
  });
});

test("a configured model is not handed to the standby generator", async () => {
  await withHarness({}, async (harness) => {
    await writeFile(harness.configPath, `${JSON.stringify({
      generator: "pi",
      piPath: harness.piPath,
      claudePath: harness.claudePath,
      model: "openai-codex/gpt-5.6-luna:high",
      timeoutMs: 5_000,
    }, null, 2)}\n`);
    await writeFile(join(harness.piDir, "fail-left"), "1\n");
    await runRename(harness, {
      args: ["--source", "pi"],
      env: { HERDR_PANE_ID: "w1:p2", HERDR_TAB_ID: "w1:t1" },
      input: promptPayload("wire up the oauth callback", harness.root),
    });
    const piArgv = JSON.parse(await readFile(join(harness.piDir, "argv.txt"), "utf8"));
    assert.equal(piArgv[piArgv.indexOf("--model") + 1], "openai-codex/gpt-5.6-luna:high");
    const claudeArgv = JSON.parse(await readFile(join(harness.claudeDir, "argv.txt"), "utf8"));
    assert.equal(claudeArgv[claudeArgv.indexOf("--model") + 1], "haiku");
  });
});

test("reports every generator when the whole chain fails", async () => {
  await withHarness({}, async (harness) => {
    await writeFile(harness.configPath, `${JSON.stringify({
      generator: "pi",
      piPath: harness.piPath,
      claudePath: join(harness.claudeDir, "absent-claude"),
      timeoutMs: 5_000,
    }, null, 2)}\n`);
    await writeFile(join(harness.piDir, "fail-left"), "1\n");
    const result = await runRename(harness, {
      args: ["--source", "pi"],
      env: { HERDR_PANE_ID: "w1:p2", HERDR_TAB_ID: "w1:t1" },
      input: promptPayload("wire up the oauth callback", harness.root),
    });
    assert.equal(result.code, 0);
    const state = await readState(harness);
    assert.equal(state.panes["w1:p2"].label, undefined);
    assert.equal(state.panes["w1:p2"].titlePrompt, "wire up the oauth callback");
    assert.match(state.lastError.message, /pi failed:/);
    assert.match(state.lastError.message, /claude failed:.*ENOENT/);
  });
});

test("retries a failed process pane rename on the next event", async () => {
  await withHarness({}, async (harness) => {
    await writeJson(join(harness.herdrDir, "fail.json"), { "pane rename": 1 });
    const event = JSON.stringify({
      data: { type: "pane_focused", pane_id: "w1:p3", workspace_id: "w1" },
    });
    const first = await runRename(harness, {
      args: ["--source", "process"],
      env: { HERDR_PLUGIN_EVENT_JSON: event },
    });
    assert.equal(first.code, 0);
    const afterFail = await readState(harness);
    assert.equal(afterFail.panes["w1:p3"].processLabel, "nvim");
    assert.notEqual(afterFail.panes["w1:p3"].appliedPane, "nvim");
    const second = await runRename(harness, {
      args: ["--source", "process"],
      env: { HERDR_PLUGIN_EVENT_JSON: event },
    });
    assert.equal(second.code, 0);
    const paneRenames = matchingCommands(await loggedCommands(harness), "pane", "rename");
    assert.equal(paneRenames.length, 2);
    assert.equal(paneRenames[1][3], "nvim");
    const state = await readState(harness);
    assert.equal(state.panes["w1:p3"].appliedPane, "nvim");
  });
});

test("retries a failed generated pane rename without regenerating", async () => {
  await withHarness({}, async (harness) => {
    await writeJson(join(harness.herdrDir, "fail.json"), { "pane rename": 1 });
    const first = await runRename(harness, {
      args: ["--source", "pi"],
      env: { HERDR_PANE_ID: "w1:p2", HERDR_TAB_ID: "w1:t1" },
      input: promptPayload("fix the oauth redirect", harness.root),
    });
    assert.equal(first.code, 0);
    const afterFail = await readState(harness);
    assert.equal(afterFail.panes["w1:p2"].label, "Fix OAuth redirect");
    await writeFile(join(harness.piDir, "fail-left"), "9\n");
    const second = await runRename(harness, {
      args: ["--source", "pi"],
      env: { HERDR_PANE_ID: "w1:p2", HERDR_TAB_ID: "w1:t1" },
      input: promptPayload("should not be sent to the generator", harness.root),
    });
    assert.equal(second.code, 0);
    const paneRenames = matchingCommands(await loggedCommands(harness), "pane", "rename");
    assert.ok(paneRenames.length >= 2);
    const state = await readState(harness);
    assert.equal(state.panes["w1:p2"].appliedPane, "Fix OAuth redirect");
    assert.equal(state.panes["w1:p2"].titlePrompt, undefined);
  });
});

test("retries a failed placeholder rename on the next agent-detected event", async () => {
  await withHarness({}, async (harness) => {
    await writeJson(join(harness.herdrDir, "fail.json"), { "pane rename": 1 });
    const event = JSON.stringify({
      data: { pane_id: "w1:p1", workspace_id: "w1", agent: "cursor" },
    });
    await runRename(harness, { args: ["--source", "agent-detected", "--default"], env: { HERDR_PLUGIN_EVENT_JSON: event } });
    const afterFail = await readState(harness);
    assert.equal(afterFail.panes["w1:p1"].defaultLabel, "Cursor");
    await runRename(harness, { args: ["--source", "agent-detected", "--default"], env: { HERDR_PLUGIN_EVENT_JSON: event } });
    const paneRenames = matchingCommands(await loggedCommands(harness), "pane", "rename");
    assert.equal(paneRenames.length, 2);
    assert.equal(paneRenames[1][3], "Cursor");
  });
});

test("retries a failed agent-release until the pane record is cleared", async () => {
  await withHarness({}, async (harness) => {
    await writeState(harness, {
      panes: {
        "w1:p1": { tabId: "w1:t1", defaultLabel: "Cursor", appliedPane: "Cursor" },
      },
    });
    await writeJson(join(harness.herdrDir, "fail.json"), { "pane rename": 1 });
    const event = JSON.stringify({
      data: { pane_id: "w1:p1", workspace_id: "w1", agent: "cursor", released: true },
    });
    await runRename(harness, { args: ["--source", "agent-detected", "--default"], env: { HERDR_PLUGIN_EVENT_JSON: event } });
    const afterFail = await readState(harness);
    assert.ok(afterFail.panes["w1:p1"]);
    assert.equal(afterFail.panes["w1:p1"].releasePending, true);
    await runRename(harness, { args: ["--source", "agent-detected", "--default"], env: { HERDR_PLUGIN_EVENT_JSON: event } });
    const state = await readState(harness);
    assert.equal(state.panes?.["w1:p1"], undefined);
    const clears = matchingCommands(await loggedCommands(harness), "pane", "rename")
      .filter((argv) => argv.includes("--clear"));
    assert.ok(clears.length >= 2);
  });
});

test("does not let a delayed placeholder overwrite a generated tab title", async () => {
  await withHarness({}, async (harness) => {
    await writeJson(join(harness.herdrDir, "delay.json"), { "pane report-metadata w1:p1": 250 });
    const placeholder = runRename(harness, {
      args: ["--source", "agent-detected", "--default"],
      env: {
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
          data: { pane_id: "w1:p1", workspace_id: "w1", agent: "cursor" },
        }),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const generated = await runRename(harness, {
      args: ["--source", "pi"],
      env: { HERDR_PANE_ID: "w1:p2", HERDR_TAB_ID: "w1:t1" },
      input: promptPayload("fix the oauth redirect", harness.root),
    });
    assert.equal(generated.code, 0);
    await placeholder;
    const tabRenames = matchingCommands(await loggedCommands(harness), "tab", "rename");
    assert.ok(tabRenames.length >= 1);
    assert.equal(tabRenames.at(-1)[3], "Fix OAuth redirect");
    const state = await readState(harness);
    assert.equal(state.panes["w1:p2"].label, "Fix OAuth redirect");
  });
});

test("timeout rejects a SIGTERM-ignoring generator at the deadline", async () => {
  await withHarness({ config: { timeoutMs: 80 } }, async (harness) => {
    const start = Date.now();
    const result = await runRename(harness, {
      args: ["--source", "pi"],
      env: {
        HERDR_PANE_ID: "w1:p2",
        HERDR_TAB_ID: "w1:t1",
        FAKE_PI_IGNORE_TERM: "1",
        FAKE_PI_DELAY_MS: "2000",
      },
      input: promptPayload("fix the oauth redirect", harness.root),
    });
    const elapsed = Date.now() - start;
    assert.equal(result.code, 0);
    assert.ok(elapsed < 800, `finished in ${elapsed}ms, not after the child ignored SIGTERM`);
    const state = await readState(harness);
    assert.match(state.lastError?.message ?? "", /timed out after 80ms/);
    assert.equal(state.panes["w1:p2"].label, undefined);
    assert.equal(state.panes["w1:p2"].titlePrompt, "fix the oauth redirect");
    assert.equal(state.panes["w1:p2"].pending, undefined);
  });
});

test("status surfaces malformed JSON and does not overwrite state", async () => {
  await withHarness({}, async (harness) => {
    await writeFile(harness.configPath, "{ generator: pi, }\n");
    await writeFile(join(harness.stateDir, "state.json"), "{ not json\n", { mode: 0o600 });
    const result = await runRename(harness, { args: ["--status"] });
    assert.equal(result.code, 0);
    const status = JSON.parse(result.stdout);
    assert.equal(status.generator, undefined);
    assert.match(status.configError, /not valid JSON/);
    assert.match(status.stateError, /not valid JSON/);
    const rawState = await readFile(join(harness.stateDir, "state.json"), "utf8");
    assert.equal(rawState, "{ not json\n");
  });
});

test("missing config still uses the Pi default, missing state starts empty", async () => {
  await withHarness({}, async (harness) => {
    const { unlink } = await import("node:fs/promises");
    await unlink(harness.configPath);
    const result = await runRename(harness, { args: ["--status"] });
    const status = JSON.parse(result.stdout);
    assert.equal(status.generator, "pi");
    assert.equal(status.configError, null);
    assert.equal(status.stateError, null);
    assert.deepEqual(status.panes, {});
  });
});

test("wrong-shape config and state are rejected without overwrite", async () => {
  await withHarness({}, async (harness) => {
    await writeFile(harness.configPath, "[]\n");
    await writeFile(join(harness.stateDir, "state.json"), "[]\n", { mode: 0o600 });
    const status = JSON.parse((await runRename(harness, { args: ["--status"] })).stdout);
    assert.match(status.configError, /JSON object/);
    assert.match(status.stateError, /JSON object/);
    assert.equal(status.generator, undefined);
    assert.equal(await readFile(join(harness.stateDir, "state.json"), "utf8"), "[]\n");
  });
});

test("malformed config does not rename tabs or invoke the default generator", async () => {
  await withHarness({}, async (harness) => {
    await writeFile(harness.configPath, "{ generator: pi, }\n");
    const result = await runRename(harness, {
      args: ["--source", "pi"],
      env: { HERDR_PANE_ID: "w1:p2", HERDR_TAB_ID: "w1:t1" },
      input: promptPayload("fix the oauth redirect", harness.root),
    });
    assert.equal(result.code, 0);
    const commands = await loggedCommands(harness);
    assert.equal(matchingCommands(commands, "pane", "rename").length, 0);
    assert.equal(matchingCommands(commands, "tab", "rename").length, 0);
    const argv = await readFile(join(harness.piDir, "argv.txt"), "utf8").catch(() => "");
    assert.equal(argv, "");
  });
});

test("Pi receives the prompt on stdin, not argv", async () => {
  await withHarness({}, async (harness) => {
    const sentinel = "SENTINEL_PROMPT_SHOULD_NOT_BE_IN_ARGV";
    await runRename(harness, {
      args: ["--source", "pi"],
      env: { HERDR_PANE_ID: "w1:p2", HERDR_TAB_ID: "w1:t1" },
      input: promptPayload(sentinel, harness.root),
    });
    const argv = JSON.parse(await readFile(join(harness.piDir, "argv.txt"), "utf8"));
    assert.equal(argv.includes(sentinel), false);
    assert.equal(argv.some((value) => value.includes(sentinel)), false);
    const stdin = await readFile(join(harness.piDir, "stdin.txt"), "utf8");
    assert.match(stdin, new RegExp(sentinel));
  });
});

test("status redacts titlePrompt and successful apply deletes it from state", async () => {
  await withHarness({}, async (harness) => {
    await writeState(harness, {
      panes: {
        "w1:p2": { tabId: "w1:t1", titlePrompt: "SECRET pending prompt", pending: "token" },
      },
    });
    const pendingStatus = JSON.parse((await runRename(harness, { args: ["--status"] })).stdout);
    assert.equal(pendingStatus.panes["w1:p2"].titlePrompt, undefined);
    assert.equal(pendingStatus.panes["w1:p2"].pending, "token");

    await writeState(harness, {
      panes: {
        "w1:p2": { tabId: "w1:t1", titlePrompt: "SECRET first prompt" },
      },
    });
    await runRename(harness, {
      args: ["--source", "pi"],
      env: { HERDR_PANE_ID: "w1:p2", HERDR_TAB_ID: "w1:t1" },
      input: promptPayload("later prompt", harness.root),
    });
    const state = await readState(harness);
    assert.equal(state.panes["w1:p2"].label, "Fix OAuth redirect");
    assert.equal(state.panes["w1:p2"].titlePrompt, undefined);
    const status = JSON.parse((await runRename(harness, { args: ["--status"] })).stdout);
    assert.equal(JSON.stringify(status).includes("SECRET"), false);
  });
});

test("status reports Herdr plugin config and state paths", async () => {
  await withHarness({}, async (harness) => {
    const status = JSON.parse((await runRename(harness, { args: ["--status"] })).stdout);
    assert.equal(status.configPath, harness.configPath);
    assert.equal(status.statePath, join(harness.stateDir, "state.json"));
  });
});

test("falls back to Herdr XDG plugin dirs when env vars are absent", async () => {
  await withHarness({}, async (harness) => {
    const env = { ...harness.env };
    delete env.HERDR_PLUGIN_CONFIG_DIR;
    delete env.HERDR_PLUGIN_STATE_DIR;
    delete env.XDG_CONFIG_HOME;
    delete env.XDG_STATE_HOME;
    const configDir = join(harness.home, ".config", "herdr", "plugins", "config", "tab-titles");
    const stateDir = join(harness.home, ".local", "state", "herdr", "plugins", "tab-titles");
    await mkdir(configDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(configDir, "tab-titles.json"), `${JSON.stringify({ generator: "claude" }, null, 2)}\n`);
    await writeFile(join(stateDir, "state.json"), `${JSON.stringify({ lastError: { message: "xdg", at: "2026-08-01T00:00:00.000Z" } }, null, 2)}\n`);
    const result = await runNode(RENAME_PATH, { args: ["--status"], env });
    const status = JSON.parse(result.stdout);
    assert.equal(status.generator, "claude");
    assert.equal(status.lastError.message, "xdg");
    assert.equal(status.configPath, join(configDir, "tab-titles.json"));
    assert.equal(status.statePath, join(stateDir, "state.json"));
  });
});

test("copies current tab-titles config and state into Herdr plugin dirs once", async () => {
  await withHarness({}, async (harness) => {
    const oldConfig = join(harness.home, ".config", "herdr", "tab-titles.json");
    const oldStateDir = join(harness.home, ".local", "state", "herdr-tab-titles");
    await writeFile(oldConfig, `${JSON.stringify({ generator: "claude", renameTab: false }, null, 2)}\n`);
    await mkdir(oldStateDir, { recursive: true });
    await writeFile(join(oldStateDir, "state.json"), `${JSON.stringify({
      lastError: { message: "kept", at: "2026-08-01T00:00:00.000Z" },
    }, null, 2)}\n`);
    await unlink(harness.configPath);
    const status = JSON.parse((await runRename(harness, { args: ["--status"] })).stdout);
    assert.equal(status.generator, "claude");
    assert.equal(status.lastError.message, "kept");
    assert.equal(status.configPath, harness.configPath);
    const copied = JSON.parse(await readFile(harness.configPath, "utf8"));
    assert.equal(copied.generator, "claude");
    const original = JSON.parse(await readFile(oldConfig, "utf8"));
    assert.equal(original.generator, "claude");
    assert.equal(JSON.parse(await readFile(join(oldStateDir, "state.json"), "utf8")).lastError.message, "kept");
  });
});

test("does not overwrite an existing Herdr plugin config with the previous custom file", async () => {
  await withHarness({}, async (harness) => {
    await writeFile(join(harness.home, ".config", "herdr", "tab-titles.json"), `${JSON.stringify({ generator: "claude" }, null, 2)}\n`);
    const status = JSON.parse((await runRename(harness, { args: ["--status"] })).stdout);
    assert.equal(status.generator, "pi");
  });
});
