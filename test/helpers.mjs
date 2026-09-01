import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(TEST_DIR);
export const RENAME_PATH = join(REPO_ROOT, "src", "rename.mjs");
export const INSTALL_PATH = join(REPO_ROOT, "scripts", "install.mjs");
const FAKE_HERDR_SRC = join(TEST_DIR, "fake-herdr.mjs");
const FAKE_PI_SRC = join(TEST_DIR, "fake-pi.mjs");

export async function makeTempDir() {
  return mkdtemp(join(TEST_DIR, ".tmp-"));
}

export async function writeExecutable(path, source) {
  await writeFile(path, source, { mode: 0o755 });
  await chmod(path, 0o755);
}

export async function createHarness(options = {}) {
  const root = await makeTempDir();
  const herdrDir = join(root, "herdr");
  const piDir = join(root, "pi");
  const claudeDir = join(root, "claude");
  const configDir = join(root, "plugin-config");
  const stateDir = join(root, "plugin-state");
  const home = join(root, "home");
  await mkdir(herdrDir, { recursive: true });
  await mkdir(piDir, { recursive: true });
  await mkdir(claudeDir, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(join(home, ".config", "herdr"), { recursive: true });
  const herdrPath = join(herdrDir, "herdr");
  const piPath = join(piDir, "pi");
  const claudePath = join(claudeDir, "claude");
  await writeExecutable(herdrPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_HERDR_SRC)} "$@"\n`);
  await writeExecutable(piPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_PI_SRC)} "$@"\n`);
  await writeExecutable(
    claudePath,
    `#!/bin/sh\nFAKE_PI_DIR=${JSON.stringify(claudeDir)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_PI_SRC)} "$@"\n`,
  );
  const configPath = join(configDir, "tab-titles.json");
  const config = {
    generator: "pi",
    piPath,
    timeoutMs: 5_000,
    renameTab: true,
    // Without this, a failing fake pi reaches the real `claude` on the test machine.
    fallback: false,
    ...options.config,
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(join(herdrDir, "panes.json"), `${JSON.stringify(options.panes ?? {
    "w1:p1": { tab_id: "w1:t1", workspace_id: "w1", cwd: root, agent: "cursor" },
    "w1:p2": { tab_id: "w1:t1", workspace_id: "w1", cwd: root, agent: "pi" },
    "w1:p3": { tab_id: "w1:t1", workspace_id: "w1", cwd: root, agent: "" },
  }, null, 2)}\n`);
  await writeFile(join(herdrDir, "commands.log"), "");
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    HERDR_ENV: "1",
    HERDR_BIN_PATH: herdrPath,
    HERDR_PLUGIN_CONFIG_DIR: configDir,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_TAB_TITLES_KILL_GRACE_MS: "80",
    FAKE_HERDR_DIR: herdrDir,
    FAKE_PI_DIR: piDir,
    ...options.env,
  };
  delete env.HERDR_TAB_TITLES_CONFIG;
  delete env.HERDR_TAB_TITLES_STATE_DIR;
  return {
    root, home, herdrDir, piDir, claudeDir, stateDir, configDir, configPath, herdrPath, piPath, claudePath, env,
  };
}

export async function removeHarness(harness) {
  await rm(harness.root, { recursive: true, force: true });
}

export function runNode(script, { args = [], env = process.env, input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.end(input);
  });
}

export function runRename(harness, { args, env, input } = {}) {
  return runNode(RENAME_PATH, { args: args ?? [], env: { ...harness.env, ...env }, input: input ?? "" });
}

export async function loggedCommands(harness) {
  const raw = await readFile(join(harness.herdrDir, "commands.log"), "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function matchingCommands(commands, kind, action) {
  return commands.filter((argv) => argv[0] === kind && argv[1] === action);
}

export async function readState(harness) {
  return JSON.parse(await readFile(join(harness.stateDir, "state.json"), "utf8"));
}

export async function writeState(harness, state) {
  await writeFile(join(harness.stateDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function promptPayload(prompt, cwd) {
  return JSON.stringify({ prompt, cwd });
}
