#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_PI_DIR;
if (!dir) process.exit(2);
writeFileSync(join(dir, "argv.txt"), `${JSON.stringify(process.argv.slice(2))}\n`);
writeFileSync(join(dir, "pid.txt"), `${process.pid}\n`);
let stdin = "";
try { stdin = readFileSync(0, "utf8"); } catch {}
writeFileSync(join(dir, "stdin.txt"), stdin);
const failFile = join(dir, "fail-left");
if (existsSync(failFile)) {
  const left = Number(readFileSync(failFile, "utf8"));
  if (left > 0) {
    writeFileSync(failFile, `${left - 1}\n`);
    process.stderr.write("generator failed\n");
    process.exit(1);
  }
}
if (process.env.FAKE_PI_IGNORE_TERM === "1") {
  process.on("SIGTERM", () => {});
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_PI_DELAY_MS || 2000)));
}
const label = process.env.FAKE_PI_LABEL || "Fix OAuth redirect";
process.stdout.write(`${label}\n`);
