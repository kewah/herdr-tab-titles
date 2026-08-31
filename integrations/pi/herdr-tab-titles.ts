// Local companion for the Herdr tab-titles plugin.
// Sends exact Pi user prompts to a detached headless-Pi naming process.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_TAB_ID) return;

  // Pi's PATH does not always include ~/.local/bin, where the installer puts the launcher.
  const installed = join(process.env.HOME || homedir(), ".local", "bin", "herdr-tab-titles");
  const launcher = existsSync(installed) ? installed : "herdr-tab-titles";

  pi.on("input", (event, ctx) => {
    if (ctx.mode !== "tui" || event.source === "extension" || !event.text.trim()) return;

    const child = spawn(launcher, ["--source", "pi"], {
      detached: true,
      env: process.env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ prompt: event.text, cwd: ctx.cwd }));
    child.unref();
  });
}
