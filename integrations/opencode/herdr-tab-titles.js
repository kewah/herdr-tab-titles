import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HEADLESS_COMMANDS = new Set(["acp", "run", "serve", "web"]);
const OPTIONS_WITH_VALUES = new Set([
  "--agent",
  "--cors",
  "--hostname",
  "--log-level",
  "--mdns-domain",
  "--model",
  "--port",
  "--prompt",
  "--replay-limit",
  "--session",
  "-m",
  "-s",
]);

function promptFromParts(parts = []) {
  return parts
    .filter((part) => part?.type === "text" && part.synthetic !== true && part.ignored !== true)
    .map((part) => String(part.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

function isInteractiveInvocation(argv = process.argv) {
  const executable = argv.findIndex((argument) => /(^|[/\\])opencode(?:\.exe)?$/.test(argument));
  const args = argv.slice(executable >= 0 ? executable + 1 : 1);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") return true;
    if (OPTIONS_WITH_VALUES.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    return !HEADLESS_COMMANDS.has(argument);
  }
  return true;
}

const plugin = async ({ directory }) => ({
  "chat.message": async (_input, output) => {
    if (process.env.HERDR_ENV !== "1" || !isInteractiveInvocation()) return;
    const prompt = promptFromParts(output.parts);
    if (!prompt) return;

    const installed = join(process.env.HOME || homedir(), ".local", "bin", "herdr-tab-titles");
    const command = existsSync(installed) ? installed : "herdr-tab-titles";
    const child = spawn(command, ["--source", "opencode"], {
      detached: true,
      env: process.env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ prompt, cwd: directory }));
    child.unref();
  },
});

// OpenCode treats every exported function as a plugin, so expose exactly one.
export const HerdrTabTitles = Object.assign(plugin, { isInteractiveInvocation, promptFromParts });
