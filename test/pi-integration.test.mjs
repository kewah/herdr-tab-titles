import assert from "node:assert/strict";
import test from "node:test";
import extension from "../integrations/pi/herdr-tab-titles.ts";

test("Pi resets on session changes, releases on quit, and leaves reload/headless runs alone", async () => {
  const previous = { HERDR_ENV: process.env.HERDR_ENV, HERDR_TAB_ID: process.env.HERDR_TAB_ID };
  const handlers = new Map();
  const calls = [];
  try {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_TAB_ID = "w1:t1";
    extension({
      on: (name, handler) => handlers.set(name, handler),
      exec: async (_command, args) => { calls.push(args); },
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const start = handlers.get("session_start");
  const shutdown = handlers.get("session_shutdown");
  for (const reason of ["startup", "new", "resume", "fork"]) {
    await start({ reason }, { mode: "tui" });
    assert.deepEqual(calls.at(-1), ["--source", "pi", "--reset"]);
  }
  assert.equal(calls.length, 4);
  await shutdown({ reason: "quit" }, { mode: "tui" });
  assert.deepEqual(calls.at(-1), ["--source", "pi", "--release"]);
  await start({ reason: "reload" }, { mode: "tui" });
  for (const reason of ["reload", "new", "resume", "fork"]) await shutdown({ reason }, { mode: "tui" });
  for (const mode of ["print", "json", "rpc"]) {
    await start({ reason: "startup" }, { mode });
    await shutdown({ reason: "quit" }, { mode });
  }
  assert.equal(calls.length, 5);
});
