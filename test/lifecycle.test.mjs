import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createHarness, removeHarness, runRename, readState, writeState,
  loggedCommands, matchingCommands,
} from "./helpers.mjs";

const env = { HERDR_PANE_ID: "w1:p2", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1" };
const old = { tabId: "w1:t1", label: "Old task title", appliedPane: "Old task title", sessionId: "old" };
async function withHarness(fn, options) {
  const harness = await createHarness(options);
  try {
    await writeState(harness, { panes: { "w1:p2": old }, tabApplied: { "w1:t1": old.label } });
    await fn(harness);
  } finally {
    await removeHarness(harness);
  }
}
function send(harness, payload, args = ["--source", "pi"]) {
  return runRename(harness, { args, env, input: JSON.stringify(payload) });
}

for (const source of ["pi", "claude-code", "codex"]) {
  test(`${source}: clear restores the agent label and permits a fresh title`, async () => {
    await withHarness(async (h) => {
      const payload = source === "pi" ? {} : { hook_event_name: "SessionStart", source: "clear", session_id: "new" };
      await send(h, payload, ["--source", source, ...(source === "pi" ? ["--reset"] : [])]);
      const record = (await readState(h)).panes["w1:p2"];
      assert.equal(record.label, undefined);
      assert.equal(record.titlePrompt, undefined);
      assert.equal(record.pending, undefined);
      assert.equal(record.appliedPane, source === "pi" ? "Pi" : source === "codex" ? "Codex" : "Claude Code");
      await send(h, { prompt: "implement the new task", session_id: "new" }, ["--source", source]);
      assert.ok((await readState(h)).panes["w1:p2"].label);
      assert.match(await readFile(join(h.piDir, "stdin.txt"), "utf8"), /implement the new task/);
    });
  });
}

test("native session end and Pi shutdown clear the pane without invoking a generator", async () => {
  for (const source of ["pi", "claude-code", "codex"]) {
    await withHarness(async (h) => {
      await send(h, { hook_event_name: "SessionEnd", session_id: "old" }, ["--source", source]);
      assert.equal((await readState(h)).panes["w1:p2"], undefined);
      const renames = matchingCommands(await loggedCommands(h), "pane", "rename");
      assert.equal(renames.at(-1)[3], "--clear");
    });
  }
});

test("compact, nested agents, and a late end from an old session leave the title alone", async () => {
  await withHarness(async (h) => {
    for (const payload of [
      { hook_event_name: "SessionStart", source: "compact" },
      { hook_event_name: "SessionStart", source: "clear", agent_id: "subagent" },
      { hook_event_name: "SessionEnd", session_id: "older" },
    ]) await send(h, payload);
    assert.deepEqual((await readState(h)).panes["w1:p2"], old);
    assert.equal((await loggedCommands(h)).length, 0);
  });
});

test("shell prompt replaces stale agent metadata and a late release preserves the process name", async () => {
  await withHarness(async (h) => {
    await send(h, {}, ["--source", "process", "--process", "bash", "--shell-prompt"]);
    assert.equal((await readState(h)).panes["w1:p2"].appliedPane, "bash");
    await runRename(h, {
      args: ["--default"],
      env: { HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ data: { pane_id: "w1:p2", released: true } }) },
    });
    assert.equal((await readState(h)).panes["w1:p2"].appliedPane, "bash");
    assert.equal(matchingCommands(await loggedCommands(h), "pane", "rename").at(-1)[3], "bash");
  });
});

test("session identity changes regenerate even when an agent has only a prompt hook", async () => {
  await withHarness(async (h) => {
    await send(h, { prompt: "new conversation task", conversation_id: "new" }, ["--source", "cursor"]);
    const record = (await readState(h)).panes["w1:p2"];
    assert.equal(record.sessionId, "new");
    assert.notEqual(record.label, old.label);
  });
});

test("reset invalidates an in-flight generator and preserves another pane's tab title", async () => {
  await withHarness(async (h) => {
    await writeState(h, { panes: {
      "w1:p1": { tabId: "w1:t1", label: "Other pane task" },
    } });
    const generating = runRename(h, {
      args: ["--source", "pi"],
      env: { ...env, FAKE_PI_DELAY_MS: "700", FAKE_PI_IGNORE_TERM: "1" },
      input: JSON.stringify({ prompt: "old delayed prompt" }),
    });
    // Wait for generation to actually start rather than relying on process startup timing.
    let started = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await readFile(join(h.piDir, "stdin.txt"), "utf8").catch(() => "")) {
        started = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(started, "generator started before reset");
    await send(h, {}, ["--source", "pi", "--reset"]);
    await generating;
    const state = await readState(h);
    assert.equal(state.panes["w1:p2"].label, undefined);
    assert.equal(state.panes["w1:p2"].appliedPane, "Pi");
    assert.equal(state.tabApplied["w1:t1"], "Other pane task");
  });
});

test("reset honors renameTab false", async () => {
  await withHarness(async (h) => {
    await send(h, { prompt: "/clear" });
    assert.equal((await readState(h)).panes["w1:p2"].appliedPane, "Pi");
    assert.equal(matchingCommands(await loggedCommands(h), "tab", "rename").length, 0);
  }, { config: { renameTab: false } });
});
