#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { spawn } from "node:child_process";

const HOME = process.env.HOME || homedir();
const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const PLUGIN_ID = "tab-titles";
const CONFIG_FILE = "tab-titles.json";
const MAX_PANES = 50;
const MAX_PROMPT_CHARS = 1600;
const DEFAULT_TIMEOUT_MS = 60_000;
// The lock only guards a read-modify-write of state.json, so a holder this old is dead.
const STALE_LOCK_MS = 5_000;
const LOCK_ATTEMPTS = 400;
const LOCK_RETRY_MS = 25;
const DEFAULT_GENERATOR = "pi";
const DEFAULT_PI_MODEL = "openai-codex/gpt-5.6-luna:minimal";
const DEFAULT_CLAUDE_MODEL = "haiku";
const DEFAULT_KILL_GRACE_MS = 1_000;
let stateUnwritable = false;

function herdrConfigHome(env = process.env, home = HOME) {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "herdr");
  return join(home, ".config", "herdr");
}

function herdrStateHome(env = process.env, home = HOME) {
  const xdg = env.XDG_STATE_HOME;
  if (xdg) return join(xdg, "herdr");
  return join(home, ".local", "state", "herdr");
}

/** Herdr plugin config directory (`HERDR_PLUGIN_CONFIG_DIR`, else XDG fallback). */
export function pluginConfigDir(env = process.env, home = HOME) {
  const injected = env.HERDR_PLUGIN_CONFIG_DIR;
  if (injected) return injected;
  return join(herdrConfigHome(env, home), "plugins", "config", PLUGIN_ID);
}

/** Herdr plugin state directory (`HERDR_PLUGIN_STATE_DIR`, else XDG fallback). */
export function pluginStateDir(env = process.env, home = HOME) {
  const injected = env.HERDR_PLUGIN_STATE_DIR;
  if (injected) return injected;
  return join(herdrStateHome(env, home), "plugins", PLUGIN_ID);
}

export function configPath(env = process.env, home = HOME) {
  return join(pluginConfigDir(env, home), CONFIG_FILE);
}

export function statePath(env = process.env, home = HOME) {
  return join(pluginStateDir(env, home), "state.json");
}

function previousCustomConfigPath(home = HOME) {
  return join(home, ".config", "herdr", CONFIG_FILE);
}

function previousCustomStateDir(home = HOME) {
  return join(home, ".local", "state", "herdr-tab-titles");
}

const STATE_DIR = pluginStateDir();
const CONFIG_PATH = configPath();
const STATE_PATH = statePath();
const LOCK_PATH = join(STATE_DIR, "state.lock");
const LOG_PATH = join(STATE_DIR, "rename.log");

const SYSTEM_PROMPT = `Create a short title for the task in the user's first message.

Write a specific 2-5 word noun phrase that captures the main goal. Summarize the task as a whole instead of listing every requested detail. Remove conversational filler, background context, URLs, and slash commands such as /simplify. Mention a tool, library, or project only when it is central to the task.

Use sentence case: capitalize only the first word and proper names or acronyms. Preserve established technical spelling. Do not begin with "Help", "Request", "Task", or "Work on". Return one title, never a numbered or bulleted list, and never include a list marker such as "1.". Return only the title, with no quotes, markdown, ending punctuation, commentary, or explanation. Keep it at most 40 characters.

Examples:
- Review a README update for clarity and accuracy -> README update review
- Add a toolkit using a Git subtree -> Git subtree toolkit integration
- Improve the UI and UX of a settings screen -> Settings UX/UI improvements
- Rebalance jobs across worker queues for peak traffic -> Worker queue rebalance strategy`;

function cleanText(value, limit = MAX_PROMPT_CHARS) {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function displayWorktreePath(value, home = HOME) {
  const path = cleanText(value, 1000).replace(/\/$/, "");
  if (!path) return "";
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function formatGitContext(root, branch) {
  const name = basename(cleanText(root, 1000).replace(/\/$/, ""));
  const ref = cleanText(branch, 200);
  return cleanText(ref ? `${name} · ${ref}` : name, 200);
}

/**
 * Claude Code submits background-task completions through UserPromptSubmit as if
 * the person had typed them, so they would otherwise be named like a request.
 */
export function isSyntheticPrompt(prompt) {
  return /^<task-notification>[\s\S]*<\/task-notification>$/.test(prompt);
}

/** The line itself, then the part of it most likely to be the bare label. */
function lineCandidates(line) {
  const colon = line.indexOf(":");
  // "Label: Fix OAuth Redirect" puts the preface first, unlike commentary after a label.
  if (colon > 0 && /\b(label|title)\b/i.test(line.slice(0, colon))) return [line, line.slice(colon + 1).trim()];
  return [line, line.split(/[(:.\u2013\u2014]/)[0]];
}

/**
 * Label spellings to try, best first.
 *
 * Answers lead with the label, so earlier lines win. Fenced blocks are dropped
 * whole: a model that explains itself in one often writes a line that would pass
 * for a label, such as "git bisect run npm test".
 */
function labelCandidates(output) {
  const plain = [];
  const fencedLines = [];
  let fenced = false;
  for (const raw of String(output ?? "").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (line) (fenced ? fencedLines : plain).push(line);
  }
  // Fenced text counts only when the model fenced its whole answer.
  const lines = plain.length ? plain : fencedLines;
  // A line ending in a colon introduces the label rather than being it.
  const usable = lines.filter((line) => !line.endsWith(":"));
  return (usable.length ? usable : lines).flatMap(lineCandidates);
}

function normalizeLabel(candidate) {
  const value = candidate
    // Small models answer in Markdown even when told not to: "# Label", "**Label**", "- Label".
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^[*_~]+|[*_~]+$/g, "")
    .replace(/^["'`]+|["'`.,:;!?]+$/g, "")
    .trim();
  if (value.length < 3 || value.length > 40 || /[\r\n]/.test(value)) return null;
  const words = value.split(/\s+/);
  if (words.length < 2 || words.length > 5) return null;
  if (!words.every((word) => /^[\p{L}\p{N}][\p{L}\p{N}+.#/'-]*$/u.test(word))) return null;
  const normalized = words.map((word) => {
    const lower = word.toLowerCase();
    if (["api", "cli", "ui", "ux", "pr", "rpc", "sql"].includes(lower)) return lower.toUpperCase();
    if (["ui/ux", "ux/ui"].includes(lower)) return lower.toUpperCase();
    if (lower === "oauth") return "OAuth";
    return word;
  }).join(" ");
  return normalized[0].toLocaleUpperCase() + normalized.slice(1);
}

export function parseLabel(output) {
  for (const candidate of labelCandidates(output)) {
    const label = normalizeLabel(candidate);
    if (label) return label;
  }
  return null;
}

async function log(message) {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const handle = await open(LOG_PATH, "a", 0o600);
  try { await handle.write(`${new Date().toISOString()} ${message}\n`); } finally { await handle.close(); }
}

/**
 * A renamer killed while holding the lock leaves the directory behind, and no
 * later run would ever get past it. Moving it aside first means only one waiter
 * breaks a given stale lock.
 */
async function breakStaleLock() {
  const info = await stat(LOCK_PATH).catch(() => null);
  if (!info || Date.now() - info.mtimeMs < STALE_LOCK_MS) return;
  const aside = `${LOCK_PATH}.stale.${process.pid}`;
  try { await rename(LOCK_PATH, aside); } catch { return; }
  await rm(aside, { recursive: true, force: true });
  await log("removed a stale state lock");
}

async function withLock(fn) {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(LOCK_PATH, { mode: 0o700 });
      try { return await fn(); } finally { await rm(LOCK_PATH, { recursive: true, force: true }); }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (attempt === LOCK_ATTEMPTS - 1) throw new Error("state lock timed out");
      await breakStaleLock();
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

async function copyFileIfAbsent(source, dest, mode = 0o600) {
  try {
    await stat(dest);
    return false;
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }
  let raw;
  try {
    raw = await readFile(source);
  } catch {
    return false;
  }
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  const temporary = `${dest}.${process.pid}.copy.tmp`;
  await writeFile(temporary, raw, { mode });
  await rename(temporary, dest);
  return true;
}

async function copyValidatedJsonIfAbsent(source, dest, validate) {
  try {
    await stat(dest);
    return false;
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }
  let raw;
  try {
    raw = await readFile(source, "utf8");
  } catch {
    return false;
  }
  try {
    validate(JSON.parse(raw));
  } catch {
    return false;
  }
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  const temporary = `${dest}.${process.pid}.copy.tmp`;
  await writeFile(temporary, raw.endsWith("\n") ? raw : `${raw}\n`, { mode: 0o600 });
  await rename(temporary, dest);
  return true;
}

async function migrateCustomLocations() {
  const oldConfig = previousCustomConfigPath();
  if (oldConfig !== CONFIG_PATH) {
    await copyValidatedJsonIfAbsent(oldConfig, CONFIG_PATH, validateConfig);
  }
  const oldStateDir = previousCustomStateDir();
  const oldState = join(oldStateDir, "state.json");
  if (oldState !== STATE_PATH) {
    await copyValidatedJsonIfAbsent(oldState, STATE_PATH, validateState);
    await copyFileIfAbsent(join(oldStateDir, "rename.log"), LOG_PATH);
  }
}

async function loadState() {
  await migrateCustomLocations();
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      stateUnwritable = true;
      throw new Error(`state is not valid JSON: ${error.message}`);
    }
    try {
      validateState(parsed);
    } catch (error) {
      stateUnwritable = true;
      throw error;
    }
    stateUnwritable = false;
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      stateUnwritable = false;
      return {};
    }
    stateUnwritable = true;
    if (String(error?.message ?? "").startsWith("state ")) throw error;
    throw new Error(`state could not be read: ${error.message}`);
  }
}

async function saveState(state) {
  if (stateUnwritable) throw new Error("refusing to overwrite unreadable state.json");
  const temporary = `${STATE_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, STATE_PATH);
}

/**
 * Keeps the most recently named panes, newest first.
 *
 * Herdr never reports that a pane closed, so entries for dead panes would otherwise
 * accumulate for as long as this file lives.
 */
export function capPanes(panes, max = MAX_PANES) {
  const entries = Object.entries(panes ?? {});
  if (entries.length <= max) return panes;
  entries.sort((a, b) => String(b[1]?.requestedAt ?? "").localeCompare(String(a[1]?.requestedAt ?? "")));
  return Object.fromEntries(entries.slice(0, max));
}

/**
 * Whether this pane may generate an automatic title.
 *
 * `prompts` recognizes state written by older releases, which generated a new
 * title from recent messages. `force` is reserved for the explicit rename-now
 * action.
 */
export function shouldGenerateTitle(record, force = false) {
  if (force) return true;
  if (record?.releasePending) return false;
  if (record?.pending) return false;
  if (record?.label) return false;
  if (record?.titlePrompt) return true;
  return !Array.isArray(record?.prompts) || record.prompts.length === 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function desiredPaneLabel(record) {
  if (!record || record.releasePending) return "";
  return record.label || record.defaultLabel || record.processLabel || "";
}

export function redactPanes(panes) {
  const redacted = {};
  for (const [id, record] of Object.entries(panes ?? {})) {
    if (!isPlainObject(record)) {
      redacted[id] = record;
      continue;
    }
    const { titlePrompt, ...rest } = record;
    redacted[id] = rest;
  }
  return redacted;
}

export function validateConfig(raw) {
  if (!isPlainObject(raw)) throw new Error("config must be a JSON object");
  const config = { ...raw };
  if (raw.generator !== undefined && raw.generator !== null) {
    const generator = String(raw.generator).toLowerCase();
    if (generator !== "pi" && generator !== "claude") {
      throw new Error(`unsupported title generator: ${JSON.stringify(raw.generator)} (expected "pi" or "claude")`);
    }
    config.generator = generator;
  }
  if (raw.model !== undefined && raw.model !== null && typeof raw.model !== "string") {
    throw new Error("model must be a string");
  }
  if (raw.renameTab !== undefined && raw.renameTab !== null && typeof raw.renameTab !== "boolean") {
    throw new Error("renameTab must be a boolean");
  }
  if (raw.piPath !== undefined && raw.piPath !== null && typeof raw.piPath !== "string") {
    throw new Error("piPath must be a string");
  }
  if (raw.claudePath !== undefined && raw.claudePath !== null && typeof raw.claudePath !== "string") {
    throw new Error("claudePath must be a string");
  }
  if (raw.timeoutMs !== undefined && raw.timeoutMs !== null) resolveTimeout(raw);
  return config;
}

function validateState(raw) {
  if (!isPlainObject(raw)) throw new Error("state must be a JSON object");
  if (raw.panes !== undefined && raw.panes !== null && !isPlainObject(raw.panes)) {
    throw new Error("state.panes must be an object");
  }
  if (raw.tabApplied !== undefined && raw.tabApplied !== null && !isPlainObject(raw.tabApplied)) {
    throw new Error("state.tabApplied must be an object");
  }
  return raw;
}

function killGraceMs() {
  const value = Number(process.env.HERDR_TAB_TITLES_KILL_GRACE_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_KILL_GRACE_MS;
}

/**
 * Whether `paneId` holds the newest first request in its tab.
 *
 * Pane labels are per pane, but a tab has one label, so it follows the pane that
 * most recently started a titled task even when an older request finishes later.
 */
export function isLatestInTab(panes, paneId) {
  const record = panes?.[paneId];
  if (!record) return false;
  const requestedAt = String(record.requestedAt ?? "");
  return Object.entries(panes).every(([id, other]) => (
    id === paneId || other?.tabId !== record.tabId || String(other?.requestedAt ?? "") <= requestedAt
  ));
}

export function pluginContext(env = process.env) {
  try { return JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON || "{}"); } catch { return {}; }
}

export function pluginEvent(env = process.env) {
  try { return JSON.parse(env.HERDR_PLUGIN_EVENT_JSON || "{}"); } catch { return {}; }
}

function agentPaneEvent(event = {}) {
  const data = event?.data && typeof event.data === "object" ? event.data : event;
  const paneId = cleanText(data?.pane_id, 80);
  if (!paneId) return null;
  return {
    paneId,
    workspaceId: cleanText(data?.workspace_id, 80),
    agent: cleanText(data?.agent, 40),
    released: data?.released === true,
  };
}

/**
 * Herdr's `pane.agent_detected` envelope when an agent is present.
 * The event's `pane_id` is the pane to rename; `HERDR_PANE_ID` is the focused
 * pane and can be a different one. `released` events are handled separately.
 */
export function detectedAgentEvent(event = {}) {
  const detected = agentPaneEvent(event);
  if (!detected || detected.released) return null;
  return { paneId: detected.paneId, workspaceId: detected.workspaceId, agent: detected.agent };
}

/**
 * The same envelope after the agent has left the pane, so the session title
 * should be cleared back to Herdr's default pane and tab names.
 */
export function releasedAgentEvent(event = {}) {
  const detected = agentPaneEvent(event);
  if (!detected?.released) return null;
  return { paneId: detected.paneId, workspaceId: detected.workspaceId, agent: detected.agent };
}

const KIND_LABELS = {
  amp: "Amp",
  antigravity: "Antigravity",
  claude: "Claude Code",
  codex: "Codex",
  copilot: "Copilot",
  cursor: "Cursor",
  devin: "Devin",
  droid: "Droid",
  grok: "Grok",
  hermes: "Hermes",
  kilo: "Kilo",
  kimi: "Kimi",
  mastracode: "MastraCode",
  omp: "OMP",
  opencode: "OpenCode",
  pi: "Pi",
  qoder: "Qoder",
  qwen: "Qwen",
};

/** Sidebar placeholder from Herdr's agent-kind slug, before a prompt exists. */
export function kindLabel(kind) {
  const key = cleanText(kind, 40).toLowerCase();
  if (!key) return "";
  if (KIND_LABELS[key]) return KIND_LABELS[key];
  return key
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ")
    .slice(0, 30);
}

/**
 * Apply a kind placeholder only when this pane has no generated title yet.
 * Re-detection bursts send the same event again; skip those.
 */
export function shouldApplyDefault(record, label) {
  if (!label) return false;
  if (record?.pending) return false;
  if (record?.label) return false;
  if (record?.releasePending) return false;
  return record?.defaultLabel !== label || record?.appliedPane !== label;
}

/**
 * A tab with a generated title from any of its panes keeps that title.
 * Otherwise the placeholder may name the tab as well.
 */
export function shouldRenameTabForDefault(panes, paneId) {
  const record = panes?.[paneId];
  if (!record) return false;
  return Object.values(panes).every((other) => other?.tabId !== record.tabId || !other?.label);
}

/**
 * Title a tab should keep after one of its panes is released: the newest
 * generated title in that tab, otherwise a remaining kind placeholder, then
 * a remaining foreground-process name.
 */
export function remainingTabLabel(panes, tabId) {
  if (!tabId) return "";
  const inTab = Object.values(panes ?? {}).filter((other) => other?.tabId === tabId);
  const newest = (key) => inTab
    .filter((other) => other[key])
    .sort((a, b) => String(b.requestedAt ?? "").localeCompare(String(a.requestedAt ?? "")));
  if (newest("label")[0]?.label) return newest("label")[0].label;
  const placeholder = inTab.find((other) => other.defaultLabel)?.defaultLabel;
  if (placeholder) return placeholder;
  return newest("processLabel")[0]?.processLabel || "";
}

/**
 * The pane a process rename should target.
 *
 * Plugin events name a specific pane (`pane.focused` has `pane_id`,
 * `pane.created` nests it on `pane`). The shell hook has no event and uses
 * the calling pane. `HERDR_PANE_ID` is the focused pane during plugin events
 * and can be a different one.
 */
export function processTarget(event = {}, env = process.env, context = {}) {
  const data = event?.data && typeof event.data === "object" ? event.data : event;
  const nested = data?.pane && typeof data.pane === "object" ? data.pane : {};
  const paneId = cleanText(data?.pane_id, 80)
    || cleanText(nested.pane_id, 80)
    || cleanText(env.HERDR_PANE_ID, 80)
    || cleanText(context.focused_pane_id, 80);
  if (!paneId) return null;
  return {
    paneId,
    workspaceId: cleanText(data?.workspace_id, 80) || cleanText(nested.workspace_id, 80),
  };
}

/** Basename of a foreground command, safe for a tab label. */
export function normalizeProcessName(value) {
  let name = cleanText(value, 80);
  if (!name) return "";
  name = name.split(/[/\\]/).pop() || "";
  name = name.replace(/^-/, "");
  if (!name || name.length > 30) return "";
  if (!/^[A-Za-z0-9][\w+.-]*$/.test(name)) return "";
  return name;
}

/**
 * Label from a hinted command, else the process that owns the pane PTY.
 * Prefer `argv0` over `name`: some CLIs report a version string as `name`.
 * Linux process-info sometimes omits `argv0` and only has `argv`.
 */
export function processLabel(info = {}, hinted = "") {
  const first = String(hinted ?? "").trim().split(/\s+/)[0] || "";
  const fromHint = normalizeProcessName(first);
  if (fromHint) return fromHint;
  const processes = Array.isArray(info.foreground_processes) ? info.foreground_processes : [];
  const pgid = info.foreground_process_group_id;
  const main = (pgid != null ? processes.find((entry) => entry?.pid === pgid) : null) || processes[0] || {};
  const argv0 = Array.isArray(main.argv) ? main.argv[0] : "";
  return normalizeProcessName(main.argv0 || argv0 || main.name || "");
}

/**
 * Process names fill panes that have no chat title and no agent placeholder.
 * Re-reports of the same command are skipped.
 */
export function shouldApplyProcess(record, label) {
  if (!label) return false;
  if (record?.pending) return false;
  if (record?.label) return false;
  if (record?.defaultLabel) return false;
  if (record?.releasePending) return false;
  return record?.processLabel !== label || record?.appliedPane !== label;
}

/**
 * A tab with a generated title or kind placeholder from any of its panes
 * keeps that title. Process names may still label the pane itself.
 */
export function shouldRenameTabForProcess(panes, paneId) {
  const record = panes?.[paneId];
  if (!record) return false;
  return Object.values(panes).every((other) => (
    other?.tabId !== record.tabId || (!other?.label && !other?.defaultLabel)
  ));
}

/** Herdr's auto tab name is the 1-based position in the workspace tab bar. */
export function positionalTabLabel(tabs, tabId) {
  const index = (tabs ?? []).findIndex((tab) => tab?.tab_id === tabId);
  return index >= 0 ? String(index + 1) : "";
}

/**
 * Working directory of the pane being named.
 *
 * Cursor's `beforeSubmitPrompt` payload has `workspace_roots` rather than `cwd`,
 * and user-level Cursor hooks run from `~/.cursor`, so `process.cwd()` is the
 * wrong fallback for that path. Herdr plugin actions still use focused-pane cwd
 * because they start from the plugin root rather than the pane.
 */
export function promptCwd(payload = {}, env = process.env, context = {}) {
  const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
  const fromRoots = roots.map((root) => cleanText(root, 1000)).find(Boolean) || "";
  return cleanText(payload.cwd, 1000)
    || fromRoots
    || cleanText(env.CURSOR_PROJECT_DIR, 1000)
    || cleanText(context.focused_pane_cwd, 1000);
}

async function loadConfig() {
  await migrateCustomLocations();
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`config is not valid JSON: ${error.message}`);
    }
    return validateConfig(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

export function resolveTimeout(config = {}) {
  if (config.timeoutMs === undefined || config.timeoutMs === null) return DEFAULT_TIMEOUT_MS;
  const timeout = Number(config.timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`timeoutMs must be a positive number of milliseconds, got ${JSON.stringify(config.timeoutMs)}`);
  }
  return timeout;
}

function stopChild(child, signal) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try { stream?.destroy(); } catch { /* already closed */ }
  }
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch { /* fall through to a direct kill */ }
  }
  try { child.kill(signal); } catch { /* already exited */ }
}

function run(command, args, { input = "", timeout = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let killTimer;
    const child = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.on("error", () => {});

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      stopChild(child, "SIGTERM");
      killTimer = setTimeout(() => stopChild(child, "SIGKILL"), killGraceMs());
      settle(reject, new Error(`${command} timed out after ${timeout}ms`));
    }, timeout);

    child.on("error", (error) => {
      clearTimeout(killTimer);
      settle(reject, error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code === 0) settle(resolve, out);
      else settle(reject, new Error(cleanText(err || `${command} exited ${code}`, 400)));
    });
    child.stdin.end(input);
  });
}

async function gitContext(directory) {
  const output = await run("git", ["-C", directory, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], {
    timeout: 3_000,
  });
  const [root, ref] = output.split("\n").map((line) => cleanText(line, 1000));
  // A detached checkout has no branch, and `--abbrev-ref` reports the literal "HEAD".
  if (ref !== "HEAD") return formatGitContext(root, ref);
  const revision = cleanText(await run("git", ["-C", directory, "rev-parse", "--short", "HEAD"], { timeout: 3_000 }), 40);
  return formatGitContext(root, revision ? `detached@${revision}` : "detached");
}

async function reportWorktree(paneId, cwd) {
  const directory = cleanText(cwd, 1000);
  if (!directory) return "";
  let display = displayWorktreePath(directory);
  try {
    display = await gitContext(directory);
  } catch {
    // A non-Git working directory still uses a concise home-relative path.
  }
  if (!display) return "";
  await run(HERDR, [
    "pane", "report-metadata", paneId,
    "--source", "tab-titles",
    "--token", `worktree=${display}`,
    "--seq", String(Date.now()),
  ], { timeout: 5_000 });
  return display;
}

async function currentPrompt(paneId, tabId) {
  const args = ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "80"];
  return cleanText(await run(HERDR, args, { timeout: 5_000 }), 5000) || `Current work in ${tabId}`;
}

export function resolveGenerator(config = {}, env = process.env) {
  const generator = String(config.generator || env.HERDR_TAB_TITLES_GENERATOR || DEFAULT_GENERATOR).toLowerCase();
  const configuredModel = config.model || env.HERDR_TAB_TITLES_MODEL;
  if (generator === "pi") {
    return {
      generator,
      command: config.piPath || env.HERDR_TAB_TITLES_PI || "pi",
      model: configuredModel || DEFAULT_PI_MODEL,
    };
  }
  if (generator === "claude") {
    return {
      generator,
      command: config.claudePath || env.HERDR_TAB_TITLES_CLAUDE || "claude",
      model: configuredModel || DEFAULT_CLAUDE_MODEL,
    };
  }
  throw new Error(`unsupported title generator: ${JSON.stringify(generator)} (expected "pi" or "claude")`);
}

async function suggestLabel(prompt, config) {
  const resolved = resolveGenerator(config);
  const timeout = resolveTimeout(config);
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) if (key.startsWith("HERDR_")) delete childEnv[key];
  const request = `First user message:\n${prompt}`;
  const args = resolved.generator === "pi"
    ? [
        "--print", "--no-session", "--no-tools", "--no-extensions",
        "--model", resolved.model, "--system-prompt", SYSTEM_PROMPT,
      ]
    : [
        "--print", "--no-session-persistence", "--tools", "",
        "--model", resolved.model, "--system-prompt", SYSTEM_PROMPT,
      ];
  const output = await run(resolved.command, args, {
    input: request,
    timeout,
    env: childEnv,
  });
  const rawOutput = stripVTControlCharacters(output).trim();
  const label = parseLabel(rawOutput);
  if (!label) {
    throw new Error(`${resolved.generator} returned an invalid label: ${JSON.stringify(cleanText(rawOutput, 100))}`);
  }
  return { label, rawOutput, model: resolved.model, generator: resolved.generator };
}

/**
 * Generate a title through the same configured CLI path used by the plugin.
 * Supplying no config intentionally reads the machine-local plugin config so
 * external evaluation tools exercise the production generator and credentials.
 */
export async function generateTitle(prompt, config) {
  return suggestLabel(prompt, config ?? await loadConfig());
}

async function recordFailure(message) {
  try {
    await withLock(async () => {
      const state = await loadState();
      state.lastError = { message, at: new Date().toISOString() };
      await saveState(state);
    });
  } catch {
    await log(`failed: ${message} (state unavailable)`).catch(() => {});
  }
}

/**
 * Apply desired pane and tab labels from current state. The tab name is
 * recomputed immediately before the Herdr mutation so a stale placeholder
 * cannot overwrite a newer generated title.
 */
async function syncLabels(paneId, tabId, workspaceId, config) {
  const panePlan = await withLock(async () => {
    const state = await loadState();
    const record = state.panes?.[paneId];
    const paneLabel = desiredPaneLabel(record);
    return {
      paneLabel,
      paneDirty: Boolean(record && paneLabel && record.appliedPane !== paneLabel),
      tabId: tabId || record?.tabId || "",
    };
  });

  if (panePlan.paneDirty) {
    await renameTarget("pane", paneId, panePlan.paneLabel);
    await withLock(async () => {
      const state = await loadState();
      const record = state.panes?.[paneId];
      if (record) {
        record.appliedPane = panePlan.paneLabel;
        if (record.label === panePlan.paneLabel) delete record.titlePrompt;
      }
      delete state.lastError;
      await saveState(state);
    });
  }

  const targetTab = panePlan.tabId;
  if (!targetTab || config.renameTab === false) return;

  let desired = "";
  let already = "";
  await withLock(async () => {
    const state = await loadState();
    desired = remainingTabLabel(state.panes, targetTab);
    already = state.tabApplied?.[targetTab] ?? "";
  });
  if (!desired) desired = positionalTabLabel(await tabList(workspaceId), targetTab);
  if (!desired || desired === already) return;
  await renameTarget("tab", targetTab, desired);
  await withLock(async () => {
    const state = await loadState();
    state.tabApplied ??= {};
    state.tabApplied[targetTab] = desired;
    await saveState(state);
  });
}

async function renameTarget(kind, id, label) {
  await run(HERDR, [kind, "rename", id, label], { timeout: 5_000 });
}

async function clearPaneLabel(paneId) {
  await run(HERDR, ["pane", "rename", paneId, "--clear"], { timeout: 5_000 });
}

async function clearWorktreeToken(paneId) {
  await run(HERDR, [
    "pane", "report-metadata", paneId,
    "--source", "tab-titles",
    "--clear-token", "worktree",
    "--seq", String(Date.now()),
  ], { timeout: 5_000 });
}

function paneFromGet(output) {
  try {
    const json = JSON.parse(output);
    return json?.result?.pane ?? {};
  } catch {
    return {};
  }
}

function processInfoFromOutput(output) {
  try {
    const json = JSON.parse(output);
    return json?.result?.process_info ?? json?.process_info ?? {};
  } catch {
    return {};
  }
}

function argvValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return "";
  return cleanText(process.argv[index + 1], 80);
}

function tabsFromList(output) {
  try {
    const json = JSON.parse(output);
    return json?.result?.tabs ?? [];
  } catch {
    return [];
  }
}

async function paneInfo(paneId) {
  return paneFromGet(await run(HERDR, ["pane", "get", paneId], { timeout: 5_000 }));
}

async function paneProcessInfo(paneId) {
  return processInfoFromOutput(await run(HERDR, ["pane", "process-info", "--pane", paneId], { timeout: 5_000 }));
}

async function tabList(workspaceId) {
  if (!workspaceId) return [];
  return tabsFromList(await run(HERDR, ["tab", "list", "--workspace", workspaceId], { timeout: 5_000 }));
}

/**
 * Drop the session title once the agent leaves, so the pane shows Herdr's
 * default name again. A tab with no remaining named pane falls back to its
 * positional number, matching an auto-named tab.
 */
async function clearOnRelease(released) {
  let tabId = "";
  let workspaceId = released.workspaceId;
  let paneGone = false;
  try {
    const pane = await paneInfo(released.paneId);
    tabId = cleanText(pane.tab_id, 80);
    workspaceId = workspaceId || cleanText(pane.workspace_id, 80);
  } catch {
    paneGone = true;
  }

  const decided = await withLock(async () => {
    const state = await loadState();
    const record = state.panes?.[released.paneId];
    if (!record) return { named: false };
    tabId = tabId || cleanText(record.tabId, 80);
    record.releasePending = true;
    await saveState(state);
    return { named: true, tabId };
  });
  if (!decided.named) return;

  if (!paneGone) {
    await clearPaneLabel(released.paneId);
    await clearWorktreeToken(released.paneId).catch(() => {});
  }

  const config = await loadConfig();
  if (config.renameTab !== false && decided.tabId) {
    let label = "";
    await withLock(async () => {
      const state = await loadState();
      const panes = { ...state.panes };
      delete panes[released.paneId];
      label = remainingTabLabel(panes, decided.tabId);
    });
    if (!label) label = positionalTabLabel(await tabList(workspaceId), decided.tabId);
    if (label) {
      await renameTarget("tab", decided.tabId, label);
      await withLock(async () => {
        const state = await loadState();
        state.tabApplied ??= {};
        state.tabApplied[decided.tabId] = label;
        await saveState(state);
      });
    }
  }

  await withLock(async () => {
    const state = await loadState();
    if (state.panes) delete state.panes[released.paneId];
    await saveState(state);
  });
  await log(`agent-released reset ${released.paneId}${decided.tabId ? ` in ${decided.tabId}` : ""}`);
}

async function applyDefault() {
  const detected = detectedAgentEvent(pluginEvent());
  if (!detected) return;
  const pane = await paneInfo(detected.paneId);
  const tabId = cleanText(pane.tab_id, 80);
  const cwd = cleanText(pane.foreground_cwd, 1000) || cleanText(pane.cwd, 1000);
  const label = kindLabel(detected.agent || pane.agent);
  if (!tabId || !label) return;

  const decided = await withLock(async () => {
    const state = await loadState();
    const previous = state.panes?.[detected.paneId];
    if (!shouldApplyDefault(previous, label)) return { apply: false };
    state.panes ??= {};
    state.panes[detected.paneId] = {
      ...previous,
      tabId,
      defaultLabel: label,
      source: "agent-detected",
    };
    state.panes = capPanes(state.panes);
    await saveState(state);
    return { apply: true };
  });

  if (decided.apply) {
    const worktree = await reportWorktree(detected.paneId, cwd);
    await withLock(async () => {
      const state = await loadState();
      const record = state.panes?.[detected.paneId];
      if (!record || record.defaultLabel !== label || record.label || record.pending) return;
      if (worktree) record.worktree = worktree;
      await saveState(state);
    });
  }

  const config = await loadConfig();
  await syncLabels(detected.paneId, tabId, detected.workspaceId, config);
  if (decided.apply) await log(`agent-detected renamed ${detected.paneId} in ${tabId} to ${JSON.stringify(label)}`);
}

/**
 * Name a pane after its foreground process when no chat title exists.
 * The shell hook can pass `--process nvim`; plugin events look the process up.
 */
async function applyProcess() {
  const target = processTarget(pluginEvent(), process.env, pluginContext());
  if (!target) return;
  let pane = {};
  try {
    pane = await paneInfo(target.paneId);
  } catch {
    return;
  }
  if (cleanText(pane.agent, 40)) return;
  const tabId = cleanText(pane.tab_id, 80);
  if (!tabId) return;

  let label = processLabel({}, argvValue("--process"));
  if (!label) {
    try {
      label = processLabel(await paneProcessInfo(target.paneId));
    } catch {
      return;
    }
  }
  if (!label) return;

  const decided = await withLock(async () => {
    const state = await loadState();
    const previous = state.panes?.[target.paneId];
    if (!shouldApplyProcess(previous, label)) return { apply: false };
    state.panes ??= {};
    state.panes[target.paneId] = {
      ...previous,
      tabId,
      processLabel: label,
      source: "process",
      requestedAt: new Date().toISOString(),
    };
    state.panes = capPanes(state.panes);
    await saveState(state);
    return { apply: true };
  });

  const config = await loadConfig();
  await syncLabels(target.paneId, tabId, target.workspaceId, config);
  if (decided.apply) await log(`process renamed ${target.paneId} in ${tabId} to ${JSON.stringify(label)}`);
}

async function status() {
  let config = {};
  let configError = null;
  try {
    config = await loadConfig();
  } catch (error) {
    configError = cleanText(error?.message || error, 400);
  }
  let state = {};
  let stateError = null;
  try {
    state = await loadState();
  } catch (error) {
    stateError = cleanText(error?.message || error, 400);
  }
  const body = {
    enabled: true,
    lastError: state.lastError ?? null,
    configError,
    stateError,
    configPath: CONFIG_PATH,
    statePath: STATE_PATH,
    panes: redactPanes(state.panes),
  };
  if (!configError) {
    const resolved = resolveGenerator(config);
    body.generator = resolved.generator;
    body.command = resolved.command;
    body.model = resolved.model;
  }
  console.log(JSON.stringify(body, null, 2));
}

async function readStdin() {
  // Run by hand in a terminal no payload is coming, and waiting for one hangs.
  if (process.stdin.isTTY) return "";
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  if (process.argv.includes("--status")) return status();
  const sourceIndex = process.argv.indexOf("--source");
  const source = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : "unknown";
  if (process.env.HERDR_ENV !== "1") return;
  if (process.argv.includes("--default")) {
    const released = releasedAgentEvent(pluginEvent());
    if (released) return clearOnRelease(released);
    return applyDefault();
  }
  if (source === "process") return applyProcess();
  const context = pluginContext();
  const tabId = process.env.HERDR_TAB_ID || context.tab_id;
  const paneId = process.env.HERDR_PANE_ID || context.focused_pane_id;
  if (!tabId || !paneId) return;

  const input = await readStdin();
  let payload = {};
  try { payload = input.trim() ? JSON.parse(input) : {}; } catch {}
  let prompt = cleanText(payload.prompt);
  if (isSyntheticPrompt(prompt)) return;
  if (!prompt && process.argv.includes("--current")) prompt = await currentPrompt(paneId, tabId);
  if (!prompt) return;

  const force = process.argv.includes("--current");
  const config = await loadConfig();
  const token = randomUUID();
  const accepted = await withLock(async () => {
    const state = await loadState();
    const previous = state.panes?.[paneId];
    if (!shouldGenerateTitle(previous, force)) return { accepted: false, prompt: previous?.titlePrompt || prompt };
    const titlePrompt = force ? prompt : (previous?.titlePrompt || prompt);
    const record = {
      ...previous,
      tabId,
      titlePrompt,
      pending: token,
      source,
      requestedAt: force || !previous?.requestedAt ? new Date().toISOString() : previous.requestedAt,
    };
    // Stop carrying the multi-prompt history written by older releases.
    delete record.prompts;
    state.panes ??= {};
    state.panes[paneId] = record;
    state.panes = capPanes(state.panes);
    await saveState(state);
    return { accepted: true, prompt: titlePrompt };
  });

  // Herdr runs plugin commands from the plugin root, so process.cwd() would report
  // this repository rather than the pane being named. Keep metadata fresh on later
  // prompts even though they cannot regenerate the title.
  const cwd = promptCwd(payload, process.env, context) || cleanText(process.cwd(), 1000);
  const worktree = await reportWorktree(paneId, cwd);
  if (accepted.accepted) {
    try {
      const { label, model, generator } = await generateTitle(accepted.prompt, config);
      const current = await withLock(async () => {
        const state = await loadState();
        const record = state.panes?.[paneId];
        if (!record || record.pending !== token) return false;
        record.label = label;
        record.worktree = worktree;
        record.generator = generator;
        record.model = model;
        record.renamedAt = new Date().toISOString();
        delete record.pending;
        delete state.lastError;
        await saveState(state);
        return true;
      });
      if (current && process.argv.includes("--current")) console.log(label);
    } catch (error) {
      const message = cleanText(error?.message || error, 500);
      await withLock(async () => {
        const state = await loadState();
        const record = state.panes?.[paneId];
        if (record?.pending === token) delete record.pending;
        state.lastError = { message, at: new Date().toISOString() };
        await saveState(state);
      });
      await log(`failed: ${message}`);
      return;
    }
  }

  await syncLabels(paneId, tabId, process.env.HERDR_WORKSPACE_ID || context.workspace_id, config);
  if (accepted.accepted) {
    const state = await loadState().catch(() => ({}));
    const applied = state.panes?.[paneId]?.label;
    if (applied) await log(`${source} renamed ${paneId} in ${tabId} to ${JSON.stringify(applied)}`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    const message = cleanText(error?.message || error, 500);
    await log(`failed: ${message}`).catch(() => {});
    // Renames run detached, so `--status` is the only place a user sees this.
    await recordFailure(message).catch(() => {});
    if (process.argv.includes("--current") || process.argv.includes("--status")) {
      console.error(error?.message || error);
      process.exitCode = 1;
    }
  });
}
