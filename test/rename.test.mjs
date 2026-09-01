import assert from "node:assert/strict";
import test from "node:test";
import * as openCodeIntegration from "../integrations/opencode/herdr-tab-titles.js";
import {
  capPanes,
  desiredPaneLabel,
  detectedAgentEvent,
  displayWorktreePath,
  formatGitContext,
  isLatestInTab,
  isSyntheticPrompt,
  kindLabel,
  normalizeProcessName,
  parseLabel,
  pluginContext,
  pluginEvent,
  pluginConfigDir,
  pluginStateDir,
  configPath,
  statePath,
  positionalTabLabel,
  processLabel,
  processTarget,
  promptCwd,
  redactPanes,
  remainingTabLabel,
  releasedAgentEvent,
  generatorChain,
  resolveGenerator,
  resolveTimeout,
  shouldApplyDefault,
  shouldGenerateTitle,
  shouldApplyProcess,
  shouldRenameTabForDefault,
  shouldRenameTabForProcess,
  validateConfig,
} from "../src/rename.mjs";

const { HerdrTabTitles } = openCodeIntegration;
const { isInteractiveInvocation, promptFromParts } = HerdrTabTitles;

test("exposes one OpenCode plugin function", async () => {
  assert.deepEqual(Object.keys(openCodeIntegration), ["HerdrTabTitles"]);
  const hooks = await HerdrTabTitles({ directory: "/home/test/repo" });
  assert.equal(typeof hooks["chat.message"], "function");
});

test("extracts a submitted OpenCode prompt from message parts", () => {
  assert.equal(promptFromParts([
    { type: "text", text: "add OpenCode support" },
    { type: "file", filename: "README.md" },
    { type: "text", text: "attached file contents", synthetic: true },
    { type: "text", text: "ignored context", ignored: true },
    { type: "text", text: "and update the docs" },
  ]), "add OpenCode support\nand update the docs");
  assert.equal(promptFromParts([]), "");
});

test("skips non-interactive OpenCode modes", () => {
  assert.equal(isInteractiveInvocation(["opencode"]), true);
  assert.equal(isInteractiveInvocation(["opencode", "--continue"]), true);
  assert.equal(isInteractiveInvocation(["opencode", "--prompt", "run"]), true);
  assert.equal(isInteractiveInvocation(["opencode", "run", "fix it"]), false);
  assert.equal(isInteractiveInvocation(["opencode", "--print-logs", "run", "fix it"]), false);
  assert.equal(isInteractiveInvocation(["opencode", "serve"]), false);
  assert.equal(isInteractiveInvocation(["opencode", "web"]), false);
  assert.equal(isInteractiveInvocation(["opencode", "acp"]), false);
});

test("accepts and normalizes concise sentence-case labels", () => {
  assert.equal(parseLabel("fix OAuth redirect\n"), "Fix OAuth redirect");
  assert.equal(parseLabel('"review API migration"'), "Review API migration");
  assert.equal(parseLabel("README update review"), "README update review");
  assert.equal(parseLabel("Git subtree toolkit integration"), "Git subtree toolkit integration");
  assert.equal(parseLabel("settings ux/ui improvements"), "Settings UX/UI improvements");
  assert.equal(parseLabel("Worker queue rebalance strategy"), "Worker queue rebalance strategy");
});

test("strips Markdown a small model adds despite the system prompt", () => {
  assert.equal(parseLabel("# Install Tab Rename Plugin"), "Install Tab Rename Plugin");
  assert.equal(parseLabel("**Install Herdr Plugin**"), "Install Herdr Plugin");
  assert.equal(parseLabel("- fix OAuth redirect"), "Fix OAuth redirect");
  assert.equal(parseLabel("1. investigate OAuth redirect"), "Investigate OAuth redirect");
  assert.equal(parseLabel("1) review API migration"), "Review API migration");
  assert.equal(parseLabel("```text\n_Review API Migration_\n```"), "Review API Migration");
});

test("recovers the label when the model appends commentary", () => {
  assert.equal(
    parseLabel("Explain Git Cloning (Note: this is not a coding task, it is a general question.)"),
    "Explain Git Cloning",
  );
  assert.equal(parseLabel("Add Invoice Export \u2014 based on the latest request"), "Add Invoice Export");
  assert.equal(parseLabel("Fix OAuth Redirect: the latest request asks for it"), "Fix OAuth Redirect");
  assert.equal(parseLabel("Here is the label:\nFix OAuth Redirect"), "Fix OAuth Redirect");
});

test("skips a preface that shares the label's line", () => {
  assert.equal(parseLabel("The label is: Fix OAuth Redirect"), "Fix OAuth Redirect");
  assert.equal(parseLabel("Task label: Review Database Migration"), "Review Database Migration");
  assert.equal(parseLabel("Title: Add Invoice Export"), "Add Invoice Export");
});

test("keeps labels in the language of the prompt", () => {
  assert.equal(parseLabel("Corregir Redirección OAuth"), "Corregir Redirección OAuth");
  assert.equal(parseLabel("ändra datumformat"), "Ändra datumformat");
});

test("ignores an explanation the model appends below the label", () => {
  const answer = [
    "Explain Git Bisect",
    "",
    "`git bisect run` automates the search.",
    "",
    "```bash",
    "git bisect run npm test",
    "```",
  ].join("\n");
  assert.equal(parseLabel(answer), "Explain Git Bisect");
});

test("trims a well-formed answer that overshoots the caps", () => {
  assert.equal(parseLabel("Migrate legacy database schema to postgres"), "Migrate legacy database schema");
  assert.equal(parseLabel("Fix flaky integration test suite timeouts"), "Fix flaky integration test");
  assert.equal(
    parseLabel("Authentication authorization synchronization reconciliation refactor"),
    "Authentication authorization synchronization",
  );
});

test("prefers a label that fits over trimming an earlier line", () => {
  assert.equal(
    parseLabel("Migrate legacy database schema to postgres\nDatabase schema migration"),
    "Database schema migration",
  );
});

test("rejects verbose or malformed labels", () => {
  assert.equal(parseLabel("One"), null);
  assert.equal(parseLabel("This Label Has Far Too Many Words"), null);
  assert.equal(parseLabel("Label: an explanation that runs far too long to be one"), null);
  assert.equal(parseLabel("I'd be happy to help you implement retry logic for that"), null);
});

test("resolves Pi and Claude title generators", () => {
  assert.deepEqual(resolveGenerator({}, {}), {
    generator: "pi",
    command: "pi",
    model: "openai-codex/gpt-5.6-luna:minimal",
  });
  assert.deepEqual(resolveGenerator({ generator: "claude" }, {}), {
    generator: "claude",
    command: "claude",
    model: "haiku",
  });
  assert.deepEqual(resolveGenerator({
    generator: "claude",
    claudePath: "/opt/claude",
    model: "sonnet",
  }, {}), {
    generator: "claude",
    command: "/opt/claude",
    model: "sonnet",
  });
});

test("falls back to the other generator, with that generator's own model", () => {
  assert.deepEqual(generatorChain({}, {}), [
    { generator: "pi", command: "pi", model: "openai-codex/gpt-5.6-luna:minimal" },
    { generator: "claude", command: "claude", model: "haiku" },
  ]);
  assert.deepEqual(generatorChain({ generator: "claude" }, {}), [
    { generator: "claude", command: "claude", model: "haiku" },
    { generator: "pi", command: "pi", model: "openai-codex/gpt-5.6-luna:minimal" },
  ]);
  assert.deepEqual(generatorChain({ model: "openai-codex/gpt-5.6-luna:high" }, {}), [
    { generator: "pi", command: "pi", model: "openai-codex/gpt-5.6-luna:high" },
    { generator: "claude", command: "claude", model: "haiku" },
  ]);
  assert.deepEqual(generatorChain({ claudePath: "/opt/claude" }, {}), [
    { generator: "pi", command: "pi", model: "openai-codex/gpt-5.6-luna:minimal" },
    { generator: "claude", command: "/opt/claude", model: "haiku" },
  ]);
});

test("honours an explicit opt out of the fallback", () => {
  assert.deepEqual(generatorChain({ fallback: false }, {}), [
    { generator: "pi", command: "pi", model: "openai-codex/gpt-5.6-luna:minimal" },
  ]);
});

test("rejects a non-boolean fallback", () => {
  assert.throws(() => validateConfig({ fallback: "yes" }), /fallback must be a boolean/);
});

test("rejects unsupported title generators", () => {
  assert.throws(
    () => resolveGenerator({ generator: "shell" }, {}),
    /unsupported title generator/,
  );
});

test("renders home-relative non-Git paths", () => {
  assert.equal(
    displayWorktreePath("/home/test/Projects/scratch", "/home/test"),
    "~/Projects/scratch",
  );
  assert.equal(displayWorktreePath("/home/test", "/home/test"), "~");
});

test("formats repository and linked-worktree context", () => {
  assert.equal(
    formatGitContext("/home/test/Projects/github/example", "main"),
    "example · main",
  );
  assert.equal(
    formatGitContext("/home/test/.worktrees/example/review-auth", "review/auth"),
    "review-auth · review/auth",
  );
});

test("reads the pane context Herdr passes to plugin actions", () => {
  const context = { focused_pane_id: "w1:p2", focused_pane_cwd: "/home/test/repo", tab_id: "w1:t1" };
  assert.deepEqual(pluginContext({ HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context) }), context);
  assert.deepEqual(pluginContext({}), {});
  assert.deepEqual(pluginContext({ HERDR_PLUGIN_CONTEXT_JSON: "not json" }), {});
});

test("resolves the pane working directory from agent payloads", () => {
  assert.equal(promptCwd({ cwd: "/home/test/from-pi" }), "/home/test/from-pi");
  assert.equal(
    promptCwd({
      cwd: "/home/test/from-pi",
      workspace_roots: ["/home/test/cursor-workspace"],
    }),
    "/home/test/from-pi",
  );
  assert.equal(
    promptCwd({ workspace_roots: ["/home/test/cursor-workspace", "/home/test/other"] }),
    "/home/test/cursor-workspace",
  );
  assert.equal(
    promptCwd({}, { CURSOR_PROJECT_DIR: "/home/test/cursor-env" }),
    "/home/test/cursor-env",
  );
  assert.equal(
    promptCwd({}, {}, { focused_pane_cwd: "/home/test/herdr-pane" }),
    "/home/test/herdr-pane",
  );
  assert.equal(
    promptCwd({ workspace_roots: ["", "  "] }, {}, { focused_pane_cwd: "/home/test/herdr-pane" }),
    "/home/test/herdr-pane",
  );
  assert.equal(promptCwd({}), "");
});

test("keeps only the most recently named panes", () => {
  const panes = Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => [`w1:p${index}`, { requestedAt: `2026-08-2${index}T00:00:00.000Z` }]),
  );
  assert.deepEqual(Object.keys(capPanes(panes, 2)), ["w1:p4", "w1:p3"]);
  assert.equal(capPanes(panes, 5), panes, "an uncapped map is returned untouched");
  assert.deepEqual(capPanes({}, 2), {});
});

test("caps panes that have never been renamed", () => {
  const panes = { "w1:p1": {}, "w1:p2": { requestedAt: "2026-08-26T00:00:00.000Z" } };
  assert.deepEqual(Object.keys(capPanes(panes, 1)), ["w1:p2"]);
});

test("recognizes Claude Code's synthetic task notifications", () => {
  assert.equal(isSyntheticPrompt("<task-notification> <task-id>abc</task-id> <status>completed</status> </task-notification>"), true);
  assert.equal(isSyntheticPrompt("close 4963 as duplicate of 4687"), false);
  assert.equal(isSyntheticPrompt("<task-notification> is what Claude sends, why?"), false);
});

test("generates an automatic title only for the first prompt in a pane", () => {
  assert.equal(shouldGenerateTitle(undefined), true);
  assert.equal(shouldGenerateTitle({ defaultLabel: "Pi" }), true);
  assert.equal(shouldGenerateTitle({ processLabel: "nvim" }), true);
  assert.equal(shouldGenerateTitle({ pending: "token" }), false, "a concurrent prompt cannot start another title");
  assert.equal(shouldGenerateTitle({ titlePrompt: "first request" }), true, "a failed generation retries the original prompt");
  assert.equal(shouldGenerateTitle({ titlePrompt: "first request", pending: "token" }), false);
  assert.equal(shouldGenerateTitle({ titlePrompt: "first request", label: "Existing title" }), false);
  assert.equal(shouldGenerateTitle({ label: "Existing title" }), false);
  assert.equal(shouldGenerateTitle({ prompts: ["legacy first request"] }), false, "old state is respected");
  assert.equal(shouldGenerateTitle({ label: "Existing title" }, true), true, "rename-now remains explicit");
  assert.equal(shouldGenerateTitle({ releasePending: true }), false);
});

test("lets only the newest request in a tab rename the tab", () => {
  const panes = {
    "w1:p1": { tabId: "w1:t1", requestedAt: "2026-08-26T10:00:00.000Z" },
    "w1:p2": { tabId: "w1:t1", requestedAt: "2026-08-26T10:00:05.000Z" },
    "w1:p3": { tabId: "w1:t2", requestedAt: "2026-08-26T11:00:00.000Z" },
  };
  assert.equal(isLatestInTab(panes, "w1:p1"), false, "an older request in the same tab");
  assert.equal(isLatestInTab(panes, "w1:p2"), true);
  assert.equal(isLatestInTab(panes, "w1:p3"), true, "other tabs do not count");
  assert.equal(isLatestInTab(panes, "w1:p9"), false);
});

test("validates the generator timeout", () => {
  assert.equal(resolveTimeout({}), 60_000);
  assert.equal(resolveTimeout({ timeoutMs: 15_000 }), 15_000);
  assert.equal(resolveTimeout({ timeoutMs: "15000" }), 15_000);
  assert.throws(() => resolveTimeout({ timeoutMs: "60s" }), /timeoutMs must be a positive number/);
  assert.throws(() => resolveTimeout({ timeoutMs: 0 }), /timeoutMs must be a positive number/);
});

test("reads the pane.agent_detected envelope Herdr injects", () => {
  const envelope = {
    event: "pane_agent_detected",
    data: { type: "pane_agent_detected", pane_id: "w1:p2", workspace_id: "w1", agent: "cursor" },
  };
  assert.deepEqual(pluginEvent({ HERDR_PLUGIN_EVENT_JSON: JSON.stringify(envelope) }), envelope);
  assert.deepEqual(pluginEvent({}), {});
  assert.deepEqual(pluginEvent({ HERDR_PLUGIN_EVENT_JSON: "not json" }), {});
});

test("extracts the detected pane from the event envelope", () => {
  assert.deepEqual(
    detectedAgentEvent({
      event: "pane_agent_detected",
      data: { type: "pane_agent_detected", pane_id: "w1:p2", workspace_id: "w1", agent: "cursor" },
    }),
    { paneId: "w1:p2", workspaceId: "w1", agent: "cursor" },
  );
  assert.deepEqual(
    detectedAgentEvent({ pane_id: "w1:p3", workspace_id: "w1", agent: "pi" }),
    { paneId: "w1:p3", workspaceId: "w1", agent: "pi" },
  );
  assert.equal(detectedAgentEvent({ data: { pane_id: "w1:p2", released: true, agent: "cursor" } }), null);
  assert.equal(detectedAgentEvent({ data: { workspace_id: "w1", agent: "cursor" } }), null);
  assert.equal(detectedAgentEvent({}), null);
});

test("extracts a released pane so its session title can be cleared", () => {
  assert.deepEqual(
    releasedAgentEvent({
      event: "pane_agent_detected",
      data: { type: "pane_agent_detected", pane_id: "w1:p2", workspace_id: "w1", agent: "cursor", released: true },
    }),
    { paneId: "w1:p2", workspaceId: "w1", agent: "cursor" },
  );
  assert.deepEqual(
    releasedAgentEvent({ pane_id: "w1:p3", workspace_id: "w1", agent: "pi", released: true }),
    { paneId: "w1:p3", workspaceId: "w1", agent: "pi" },
  );
  assert.equal(releasedAgentEvent({ data: { pane_id: "w1:p2", agent: "cursor" } }), null);
  assert.equal(releasedAgentEvent({ data: { released: true, agent: "cursor" } }), null);
  assert.equal(releasedAgentEvent({}), null);
});

test("maps Herdr agent kinds to sidebar placeholders", () => {
  assert.equal(kindLabel("claude"), "Claude Code");
  assert.equal(kindLabel("pi"), "Pi");
  assert.equal(kindLabel("codex"), "Codex");
  assert.equal(kindLabel("cursor"), "Cursor");
  assert.equal(kindLabel("opencode"), "OpenCode");
  assert.equal(kindLabel("CLAUDE"), "Claude Code");
  assert.equal(kindLabel("some-new-agent"), "Some New Agent");
  assert.equal(kindLabel(""), "");
  assert.equal(kindLabel(undefined), "");
});

test("applies a kind placeholder only before a generated title exists", () => {
  assert.equal(shouldApplyDefault(undefined, "Cursor"), true);
  assert.equal(shouldApplyDefault({}, "Cursor"), true);
  assert.equal(shouldApplyDefault({ defaultLabel: "Pi" }, "Cursor"), true, "kind changed");
  assert.equal(shouldApplyDefault({ defaultLabel: "Cursor" }, "Cursor"), true, "retry until the pane rename lands");
  assert.equal(shouldApplyDefault({ defaultLabel: "Cursor", appliedPane: "Cursor" }, "Cursor"), false, "already applied");
  assert.equal(shouldApplyDefault({ label: "Fix OAuth Redirect" }, "Cursor"), false);
  assert.equal(shouldApplyDefault({ pending: "token", defaultLabel: "Pi" }, "Cursor"), false);
  assert.equal(shouldApplyDefault({}, ""), false);
});

test("does not let a placeholder steal a tab that already has a task title", () => {
  const panes = {
    "w1:p1": { tabId: "w1:t1", label: "Fix OAuth Redirect" },
    "w1:p2": { tabId: "w1:t1", defaultLabel: "Cursor" },
    "w1:p3": { tabId: "w1:t2", defaultLabel: "Pi" },
  };
  assert.equal(shouldRenameTabForDefault(panes, "w1:p2"), false, "sibling already named the tab");
  assert.equal(shouldRenameTabForDefault(panes, "w1:p3"), true, "no generated title in this tab");
  assert.equal(shouldRenameTabForDefault(panes, "w1:p9"), false);
});

test("picks a remaining tab title after a pane is released", () => {
  const panes = {
    "w1:p1": { tabId: "w1:t1", label: "Fix OAuth Redirect", requestedAt: "2026-08-26T10:00:00.000Z" },
    "w1:p2": { tabId: "w1:t1", label: "Add Invoice Export", requestedAt: "2026-08-26T10:00:05.000Z" },
    "w1:p3": { tabId: "w1:t2", defaultLabel: "Pi" },
  };
  assert.equal(remainingTabLabel(panes, "w1:t1"), "Add Invoice Export");
  assert.equal(
    remainingTabLabel({ "w1:p1": panes["w1:p1"], "w1:p3": panes["w1:p3"] }, "w1:t1"),
    "Fix OAuth Redirect",
  );
  assert.equal(remainingTabLabel({ "w1:p3": panes["w1:p3"] }, "w1:t2"), "Pi");
  assert.equal(
    remainingTabLabel({
      "w1:p4": { tabId: "w1:t3", processLabel: "nvim", requestedAt: "2026-08-26T10:00:00.000Z" },
      "w1:p5": { tabId: "w1:t3", processLabel: "git", requestedAt: "2026-08-26T10:00:05.000Z" },
    }, "w1:t3"),
    "git",
  );
  assert.equal(remainingTabLabel(panes, "w1:t9"), "");
  assert.equal(remainingTabLabel({}, "w1:t1"), "");
});

test("maps a tab back to Herdr's positional default name", () => {
  const tabs = [
    { tab_id: "w1:tM", label: "Delete Worktree and Branch" },
    { tab_id: "w1:tQ", label: "Reset Panel Name on Exit" },
  ];
  assert.equal(positionalTabLabel(tabs, "w1:tM"), "1");
  assert.equal(positionalTabLabel(tabs, "w1:tQ"), "2");
  assert.equal(positionalTabLabel(tabs, "w1:t9"), "");
  assert.equal(positionalTabLabel([], "w1:tQ"), "");
});

test("normalizes a foreground command into a tab label", () => {
  assert.equal(normalizeProcessName("/usr/bin/nvim"), "nvim");
  assert.equal(normalizeProcessName("-zsh"), "zsh");
  assert.equal(normalizeProcessName("git"), "git");
  assert.equal(normalizeProcessName("FOO=bar"), "");
  assert.equal(normalizeProcessName(""), "");
  assert.equal(normalizeProcessName("this-name-is-way-too-long-to-fit-a-tab"), "");
});

test("reads the foreground process from process-info, preferring argv0", () => {
  const info = {
    foreground_process_group_id: 10,
    foreground_processes: [
      { pid: 11, name: "pyright-langserver", argv0: "node" },
      { pid: 10, name: "2.1.220", argv0: "claude" },
    ],
  };
  assert.equal(processLabel(info), "claude");
  assert.equal(processLabel(info, "nvim src/rename.mjs"), "nvim");
  assert.equal(processLabel({ foreground_processes: [{ argv0: "/usr/bin/git" }] }), "git");
  assert.equal(processLabel({
    foreground_process_group_id: 17528,
    foreground_processes: [{
      pid: 17528,
      name: "MainThread",
      argv: ["/home/test/.local/bin/agent", "--use-system-ca"],
    }],
  }), "agent");
  assert.equal(processLabel({}), "");
});

test("targets the event pane rather than the focused pane", () => {
  assert.deepEqual(
    processTarget({
      event: "pane_focused",
      data: { type: "pane_focused", pane_id: "w1:p2", workspace_id: "w1" },
    }, { HERDR_PANE_ID: "w1:p1" }),
    { paneId: "w1:p2", workspaceId: "w1" },
  );
  assert.deepEqual(
    processTarget({
      event: "pane_created",
      data: { type: "pane_created", pane: { pane_id: "w1:p3", workspace_id: "w1" } },
    }, {}),
    { paneId: "w1:p3", workspaceId: "w1" },
  );
  assert.deepEqual(
    processTarget({}, { HERDR_PANE_ID: "w1:p4" }),
    { paneId: "w1:p4", workspaceId: "" },
  );
  assert.equal(processTarget({}, {}), null);
});

test("applies a process name only when no chat title exists", () => {
  assert.equal(shouldApplyProcess(undefined, "nvim"), true);
  assert.equal(shouldApplyProcess({}, "nvim"), true);
  assert.equal(shouldApplyProcess({ processLabel: "zsh" }, "nvim"), true, "command changed");
  assert.equal(shouldApplyProcess({ processLabel: "nvim" }, "nvim"), true, "retry until the pane rename lands");
  assert.equal(shouldApplyProcess({ processLabel: "nvim", appliedPane: "nvim" }, "nvim"), false, "already applied");
  assert.equal(shouldApplyProcess({ label: "Fix OAuth Redirect" }, "nvim"), false);
  assert.equal(shouldApplyProcess({ defaultLabel: "Claude Code" }, "nvim"), false);
  assert.equal(shouldApplyProcess({ pending: "token" }, "nvim"), false);
  assert.equal(shouldApplyProcess({}, ""), false);
});

test("does not let a process name steal a tab that already has a task title", () => {
  const panes = {
    "w1:p1": { tabId: "w1:t1", label: "Fix OAuth Redirect" },
    "w1:p2": { tabId: "w1:t1", processLabel: "nvim" },
    "w1:p3": { tabId: "w1:t2", defaultLabel: "Pi" },
    "w1:p4": { tabId: "w1:t3", processLabel: "zsh" },
  };
  assert.equal(shouldRenameTabForProcess(panes, "w1:p2"), false, "sibling already named the tab");
  assert.equal(shouldRenameTabForProcess(panes, "w1:p3"), false, "kind placeholder owns the tab");
  assert.equal(shouldRenameTabForProcess(panes, "w1:p4"), true);
  assert.equal(shouldRenameTabForProcess(panes, "w1:p9"), false);
});

test("picks the desired pane label from generated, placeholder, then process names", () => {
  assert.equal(desiredPaneLabel({ label: "Fix OAuth Redirect", defaultLabel: "Pi" }), "Fix OAuth Redirect");
  assert.equal(desiredPaneLabel({ defaultLabel: "Pi", processLabel: "nvim" }), "Pi");
  assert.equal(desiredPaneLabel({ processLabel: "nvim" }), "nvim");
  assert.equal(desiredPaneLabel({ releasePending: true, defaultLabel: "Pi" }), "");
  assert.equal(desiredPaneLabel(undefined), "");
});

test("redacts raw titlePrompt from status pane records", () => {
  assert.deepEqual(redactPanes({
    "w1:p1": { tabId: "w1:t1", titlePrompt: "secret", label: "Fix OAuth Redirect" },
  }), {
    "w1:p1": { tabId: "w1:t1", label: "Fix OAuth Redirect" },
  });
});

test("validates recognized config fields", () => {
  assert.deepEqual(validateConfig({ generator: "claude", renameTab: false }), {
    generator: "claude",
    renameTab: false,
  });
  assert.throws(() => validateConfig([]), /config must be a JSON object/);
  assert.throws(() => validateConfig({ renameTab: "yes" }), /renameTab must be a boolean/);
  assert.throws(() => validateConfig({ generator: "shell" }), /unsupported title generator/);
});

test("resolves Herdr plugin config and state directories", () => {
  assert.equal(
    pluginConfigDir({}, "/home/test"),
    "/home/test/.config/herdr/plugins/config/tab-titles",
  );
  assert.equal(
    pluginStateDir({}, "/home/test"),
    "/home/test/.local/state/herdr/plugins/tab-titles",
  );
  assert.equal(
    pluginConfigDir({ XDG_CONFIG_HOME: "/xdg/config" }, "/home/test"),
    "/xdg/config/herdr/plugins/config/tab-titles",
  );
  assert.equal(
    pluginStateDir({ XDG_STATE_HOME: "/xdg/state" }, "/home/test"),
    "/xdg/state/herdr/plugins/tab-titles",
  );
  assert.equal(
    pluginConfigDir({ HERDR_PLUGIN_CONFIG_DIR: "/injected/config" }, "/home/test"),
    "/injected/config",
  );
  assert.equal(
    pluginStateDir({ HERDR_PLUGIN_STATE_DIR: "/injected/state" }, "/home/test"),
    "/injected/state",
  );
  assert.equal(
    configPath({ HERDR_PLUGIN_CONFIG_DIR: "/injected/config" }, "/home/test"),
    "/injected/config/tab-titles.json",
  );
  assert.equal(
    statePath({ HERDR_PLUGIN_STATE_DIR: "/injected/state" }, "/home/test"),
    "/injected/state/state.json",
  );
});
