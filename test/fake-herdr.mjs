#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_HERDR_DIR;
if (!dir) process.exit(2);
appendFileSync(join(dir, "commands.log"), `${JSON.stringify(process.argv.slice(2))}\n`);
const key = `${process.argv[2] ?? ""} ${process.argv[3] ?? ""}`.trim();
const specific = `${key} ${process.argv[4] ?? ""}`.trim();

function consume(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

const delays = consume(join(dir, "delay.json"), {});
const ms = Number(delays[specific] || delays[key] || 0);
if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));

const fails = consume(join(dir, "fail.json"), {});
const failKey = fails[specific] != null ? specific : key;
if (Number(fails[failKey] || 0) > 0) {
  fails[failKey] -= 1;
  writeFileSync(join(dir, "fail.json"), `${JSON.stringify(fails)}\n`);
  process.stderr.write(`fake herdr failing ${failKey}\n`);
  process.exit(1);
}

const panes = consume(join(dir, "panes.json"), {});
const tabs = consume(join(dir, "tabs.json"), [{ tab_id: "w1:t1" }]);
const processes = consume(join(dir, "process.json"), {});
const [kind, action, ...rest] = process.argv.slice(2);
if (kind === "pane" && action === "get") {
  const pane = panes[rest[0]] ?? { tab_id: "w1:t1", workspace_id: "w1", cwd: dir, agent: "" };
  process.stdout.write(`${JSON.stringify({ result: { pane } })}\n`);
} else if (kind === "pane" && action === "process-info") {
  const paneId = rest[1] || rest[0];
  const info = processes[paneId] ?? { foreground_processes: [{ argv0: "nvim" }] };
  process.stdout.write(`${JSON.stringify({ result: { process_info: info } })}\n`);
} else if (kind === "tab" && action === "list") {
  process.stdout.write(`${JSON.stringify({ result: { tabs } })}\n`);
} else if (kind === "pane" && action === "read") {
  process.stdout.write("current terminal contents\n");
}
