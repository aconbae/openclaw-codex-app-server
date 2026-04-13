#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const PLUGIN_ID = "openclaw-codex-app-server";
const PLUGIN_NAME = "OpenClaw Plugin For Codex App Server";
const TELEGRAM_CHANNEL = "telegram";
const ACCOUNT_ID = "default";
const CONVERSATION_ID = "codex-smoke-chat";
const SENDER_ID = "codex-smoke-user";

function log(message) {
  console.log(`[openclaw-persistence-smoke] ${message}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseArgs(argv) {
  const options = {
    cwd: REPO_ROOT,
    keepTemp: false,
    phase: undefined,
    tmpRoot: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") {
      options.cwd = path.resolve(argv[++index]);
      continue;
    }
    if (arg === "--tmp-root") {
      options.tmpRoot = path.resolve(argv[++index]);
      continue;
    }
    if (arg === "--phase") {
      options.phase = argv[++index];
      continue;
    }
    if (arg === "--keep-temp") {
      options.keepTemp = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: node scripts/openclaw-persistence-smoke.mjs [options]",
          "",
          "Options:",
          "  --cwd <dir>        Workspace directory to bind to Codex (default: repo root)",
          "  --keep-temp        Preserve the temporary OpenClaw smoke home after success",
          "  --phase <name>     Internal: run one child phase",
          "  --tmp-root <dir>   Internal: reuse a specific temporary root",
        ].join("\n"),
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function resolveOriginalHome() {
  return process.env.ORIGINAL_HOME?.trim() || process.env.HOME?.trim() || os.homedir();
}

function resolveOriginalCodexHome() {
  return (
    process.env.ORIGINAL_CODEX_HOME?.trim() ||
    process.env.CODEX_HOME?.trim() ||
    path.join(resolveOriginalHome(), ".codex")
  );
}

function resolveHarnessPaths(tmpRoot) {
  const homeDir = path.join(tmpRoot, "home");
  const stateDir = path.join(homeDir, ".openclaw");
  return {
    homeDir,
    stateDir,
    approvalsPath: path.join(stateDir, "plugin-binding-approvals.json"),
    currentBindingsPath: path.join(stateDir, "bindings", "current-conversations.json"),
    pluginStatePath: path.join(stateDir, PLUGIN_ID, "state.json"),
    reportPath: path.join(tmpRoot, "report.json"),
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function updateReport(tmpRoot, phase, value) {
  const { reportPath } = resolveHarnessPaths(tmpRoot);
  const current = (await readJsonIfExists(reportPath)) ?? {};
  current[phase] = value;
  await writeJson(reportPath, current);
}

async function loadReport(tmpRoot) {
  const { reportPath } = resolveHarnessPaths(tmpRoot);
  return (await readJsonIfExists(reportPath)) ?? {};
}

async function seedApprovals(tmpRoot) {
  const { approvalsPath } = resolveHarnessPaths(tmpRoot);
  await writeJson(approvalsPath, {
    version: 1,
    approvals: [
      {
        pluginRoot: REPO_ROOT,
        pluginId: PLUGIN_ID,
        pluginName: PLUGIN_NAME,
        channel: TELEGRAM_CHANNEL,
        accountId: ACCOUNT_ID,
        approvedAt: Date.now(),
      },
    ],
  });
}

function buildChildEnv(tmpRoot) {
  const { homeDir, stateDir } = resolveHarnessPaths(tmpRoot);
  return {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_STATE_DIR: stateDir,
    ORIGINAL_HOME: resolveOriginalHome(),
    ORIGINAL_CODEX_HOME: resolveOriginalCodexHome(),
    CODEX_HOME: resolveOriginalCodexHome(),
  };
}

async function runPhaseInChild(phase, options) {
  log(`starting phase=${phase}`);
  const child = spawn(
    process.execPath,
    [SCRIPT_PATH, "--phase", phase, "--tmp-root", options.tmpRoot, "--cwd", options.cwd],
    {
      cwd: REPO_ROOT,
      env: buildChildEnv(options.tmpRoot),
      stdio: "inherit",
    },
  );
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`phase ${phase} exited with signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`phase ${phase} failed with exit code ${exitCode}`);
  }
  log(`completed phase=${phase}`);
}

function summarizeReply(result) {
  const text = typeof result?.text === "string" ? result.text.trim() : undefined;
  const interactiveRows = Array.isArray(result?.interactive?.blocks)
    ? result.interactive.blocks.length
    : undefined;
  return {
    text,
    interactiveRows,
  };
}

function resolveOpenClawDistDir() {
  const require = createRequire(import.meta.url);
  return path.dirname(require.resolve("openclaw"));
}

async function importOpenClawPrivateModule(prefix, requiredSnippet) {
  const distDir = resolveOpenClawDistDir();
  const entry = fs
    .readdirSync(distDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".js"))
    .toSorted()
    .find((name) => {
      if (!requiredSnippet) {
        return true;
      }
      const filePath = path.join(distDir, name);
      return fs.readFileSync(filePath, "utf8").includes(requiredSnippet);
    });
  if (!entry) {
    throw new Error(
      `Unable to resolve OpenClaw dist module with prefix ${prefix}${requiredSnippet ? ` containing ${requiredSnippet}` : ""}`,
    );
  }
  return await import(pathToFileURL(path.join(distDir, entry)).href);
}

async function loadHostModules() {
  const [loaderModule, commandsModule] = await Promise.all([
    importOpenClawPrivateModule("loader-", "function loadOpenClawPlugins"),
    importOpenClawPrivateModule("commands-", "async function executePluginCommand"),
  ]);
  const loadOpenClawPlugins = loaderModule.r;
  const matchPluginCommand = commandsModule.i;
  const executePluginCommand = commandsModule.n;
  assert(typeof loadOpenClawPlugins === "function", "OpenClaw loader export not found");
  assert(typeof matchPluginCommand === "function", "OpenClaw command matcher export not found");
  assert(typeof executePluginCommand === "function", "OpenClaw command executor export not found");
  return {
    loadOpenClawPlugins,
    matchPluginCommand,
    executePluginCommand,
  };
}

function buildPluginConfig(cwd) {
  return {
    plugins: {
      enabled: true,
      allow: [PLUGIN_ID],
      load: {
        paths: [REPO_ROOT],
      },
      slots: {
        memory: "none",
      },
      entries: {
        [PLUGIN_ID]: {
          enabled: true,
          config: {
            enabled: true,
            requestTimeoutMs: 30_000,
            defaultWorkspaceDir: cwd,
          },
        },
      },
    },
  };
}

function registerHeadlessTelegramChannel(registry) {
  const plugin = {
    id: TELEGRAM_CHANNEL,
    bindings: {
      resolveCommandConversation: ({ originatingTo, commandTo, fallbackTo }) => ({
        conversationId:
          commandTo?.trim() || fallbackTo?.trim() || originatingTo?.trim() || CONVERSATION_ID,
      }),
    },
    conversationBindings: {
      supportsCurrentConversationBinding: true,
    },
  };
  registry.channels = registry.channels.filter((entry) => entry?.plugin?.id !== TELEGRAM_CHANNEL);
  registry.channels.push({
    pluginId: "smoke-harness",
    pluginName: "Smoke Harness Telegram",
    plugin,
    source: SCRIPT_PATH,
    rootDir: REPO_ROOT,
  });
}

async function createHarness(options) {
  const host = await loadHostModules();
  const registry = host.loadOpenClawPlugins({
    workspaceDir: REPO_ROOT,
    env: process.env,
    config: buildPluginConfig(options.cwd),
    cache: false,
    activate: true,
    onlyPluginIds: [PLUGIN_ID],
  });
  const pluginRecord = registry.plugins.find(
    (entry) => entry.id === PLUGIN_ID && entry.status === "loaded",
  );
  assert(pluginRecord, `OpenClaw failed to load ${PLUGIN_ID}`);
  registerHeadlessTelegramChannel(registry);
  return {
    ...host,
    async close() {
      for (const entry of registry.services ?? []) {
        await entry?.service?.stop?.().catch(() => undefined);
      }
    },
  };
}

async function executeCommand(host, commandBody) {
  const matched = host.matchPluginCommand(commandBody);
  assert(matched, `OpenClaw did not match command ${commandBody}`);
  const result = await host.executePluginCommand({
    ...matched,
    senderId: SENDER_ID,
    channel: TELEGRAM_CHANNEL,
    channelId: TELEGRAM_CHANNEL,
    isAuthorizedSender: true,
    commandBody,
    config: {},
    from: SENDER_ID,
    to: CONVERSATION_ID,
    accountId: ACCOUNT_ID,
  });
  return result && typeof result === "object" ? result : {};
}

function readSingleBinding(snapshot) {
  const bindings = Array.isArray(snapshot?.bindings) ? snapshot.bindings : [];
  assert(bindings.length === 1, `expected exactly one plugin binding, found ${bindings.length}`);
  return bindings[0];
}

function readSingleCurrentBinding(snapshot) {
  const bindings = Array.isArray(snapshot?.bindings) ? snapshot.bindings : [];
  assert(
    bindings.length === 1,
    `expected exactly one OpenClaw current binding, found ${bindings.length}`,
  );
  return bindings[0];
}

async function phaseBind(options) {
  const paths = resolveHarnessPaths(options.tmpRoot);
  const host = await createHarness(options);
  try {
    const resumeReply = await executeCommand(host, "/cas_resume --new --no-yolo .");
    const pluginState = await readJsonIfExists(paths.pluginStatePath);
    assert(pluginState, `plugin state file missing after bind: ${paths.pluginStatePath}`);
    const binding = readSingleBinding(pluginState);
    assert(binding.threadId?.trim(), "plugin binding missing thread id");
    assert(binding.sessionKey?.trim(), "plugin binding missing session key");
    assert(
      path.resolve(binding.workspaceDir) === path.resolve(options.cwd),
      `expected workspace ${options.cwd}, got ${binding.workspaceDir}`,
    );
    const currentBindings = await readJsonIfExists(paths.currentBindingsPath);
    assert(
      currentBindings,
      `OpenClaw current-conversations file missing after bind: ${paths.currentBindingsPath}`,
    );
    const currentBinding = readSingleCurrentBinding(currentBindings);
    assert(
      typeof currentBinding.targetSessionKey === "string" &&
        currentBinding.targetSessionKey.startsWith(`plugin-binding:${PLUGIN_ID}:`),
      `expected OpenClaw plugin-binding session key, got ${currentBinding.targetSessionKey}`,
    );
    assert(
      currentBinding.conversation?.channel === TELEGRAM_CHANNEL,
      `expected channel ${TELEGRAM_CHANNEL}, got ${currentBinding.conversation?.channel}`,
    );
    assert(
      currentBinding.conversation?.conversationId === CONVERSATION_ID,
      `expected conversation ${CONVERSATION_ID}, got ${currentBinding.conversation?.conversationId}`,
    );
    assert(
      currentBinding.metadata?.pluginId === PLUGIN_ID,
      `expected current binding metadata.pluginId=${PLUGIN_ID}, got ${currentBinding.metadata?.pluginId}`,
    );
    const statusReply = await executeCommand(host, "/cas_status");
    if (typeof statusReply.text === "string" && statusReply.text.trim()) {
      assert(
        statusReply.text.includes(`Thread: ${binding.threadId}`),
        "status reply did not include the bound thread id",
      );
    }
    await updateReport(options.tmpRoot, "bind", {
      reply: summarizeReply(resumeReply),
      statusReply: summarizeReply(statusReply),
      threadId: binding.threadId,
      sessionKey: binding.sessionKey,
      workspaceDir: binding.workspaceDir,
      permissionsMode: binding.permissionsMode,
    });
    log(`bind phase created thread=${binding.threadId} session=${binding.sessionKey}`);
  } finally {
    await host.close();
  }
}

async function phaseRestart(options) {
  const report = await loadReport(options.tmpRoot);
  assert(report.bind?.threadId, "bind phase report missing thread id");
  const paths = resolveHarnessPaths(options.tmpRoot);
  const host = await createHarness(options);
  try {
    const statusReply = await executeCommand(host, "/cas_status");
    const preservedState = await readJsonIfExists(paths.pluginStatePath);
    assert(preservedState, "plugin state file missing after restart");
    const binding = readSingleBinding(preservedState);
    assert(
      binding.threadId === report.bind.threadId,
      `expected preserved thread ${report.bind.threadId}, got ${binding.threadId}`,
    );
    assert(
      binding.sessionKey === report.bind.sessionKey,
      `expected preserved session ${report.bind.sessionKey}, got ${binding.sessionKey}`,
    );
    assert(
      path.resolve(binding.workspaceDir) === path.resolve(report.bind.workspaceDir),
      `expected preserved workspace ${report.bind.workspaceDir}, got ${binding.workspaceDir}`,
    );
    if (typeof statusReply.text === "string" && statusReply.text.trim()) {
      assert(
        statusReply.text.includes(`Thread: ${report.bind.threadId}`),
        "status reply after restart did not include the bound thread id",
      );
    }
    await updateReport(options.tmpRoot, "restart", {
      statusReply: summarizeReply(statusReply),
      preservedThreadId: binding.threadId,
      preservedSessionKey: binding.sessionKey,
    });
    log(`restart phase preserved thread=${binding.threadId} across OpenClaw/plugin restart`);
  } finally {
    await host.close();
  }
}

async function phaseDetach(options) {
  const paths = resolveHarnessPaths(options.tmpRoot);
  const host = await createHarness(options);
  try {
    const detachReply = await executeCommand(host, "/cas_detach");
    assert(
      detachReply.text === "Detached this conversation from Codex.",
      `unexpected detach reply: ${detachReply.text ?? "<empty>"}`,
    );
    const pluginState = await readJsonIfExists(paths.pluginStatePath);
    const pluginBindings = Array.isArray(pluginState?.bindings) ? pluginState.bindings : [];
    assert(
      pluginBindings.length === 0,
      `expected no plugin bindings after detach, found ${pluginBindings.length}`,
    );
    const currentBindings = await readJsonIfExists(paths.currentBindingsPath);
    const openClawBindings = Array.isArray(currentBindings?.bindings) ? currentBindings.bindings : [];
    assert(
      openClawBindings.length === 0,
      `expected no OpenClaw current bindings after detach, found ${openClawBindings.length}`,
    );
    await updateReport(options.tmpRoot, "detach", {
      detachReply: summarizeReply(detachReply),
    });
    log("detach phase cleared plugin and OpenClaw binding persistence");
  } finally {
    await host.close();
  }
}

async function phaseFinal(options) {
  const paths = resolveHarnessPaths(options.tmpRoot);
  const host = await createHarness(options);
  try {
    const statusReply = await executeCommand(host, "/cas_status");
    assert(
      typeof statusReply.text === "string" && statusReply.text.includes("Binding: none"),
      `expected final status reply to show no binding, got ${statusReply.text ?? "<empty>"}`,
    );
    const pluginState = await readJsonIfExists(paths.pluginStatePath);
    const pluginBindings = Array.isArray(pluginState?.bindings) ? pluginState.bindings : [];
    const currentBindings = await readJsonIfExists(paths.currentBindingsPath);
    const openClawBindings = Array.isArray(currentBindings?.bindings) ? currentBindings.bindings : [];
    assert(
      pluginBindings.length === 0,
      `expected no plugin bindings in final phase, found ${pluginBindings.length}`,
    );
    assert(
      openClawBindings.length === 0,
      `expected no OpenClaw bindings in final phase, found ${openClawBindings.length}`,
    );
    await updateReport(options.tmpRoot, "final", {
      statusReply: summarizeReply(statusReply),
    });
    log("final phase confirmed detached state after a fresh restart");
  } finally {
    await host.close();
  }
}

async function runPhase(options) {
  switch (options.phase) {
    case "bind":
      await phaseBind(options);
      return;
    case "restart":
      await phaseRestart(options);
      return;
    case "detach":
      await phaseDetach(options);
      return;
    case "final":
      await phaseFinal(options);
      return;
    default:
      throw new Error(`Unknown phase: ${options.phase}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.phase) {
    assert(options.tmpRoot, "--phase requires --tmp-root");
    await runPhase(options);
    return;
  }
  const tmpRoot =
    options.tmpRoot ??
    (await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-persistence-smoke-")));
  const nextOptions = {
    ...options,
    tmpRoot,
  };
  await seedApprovals(tmpRoot);
  log(`temporary root: ${tmpRoot}`);
  log(`workspace: ${options.cwd}`);
  log(`real CODEX_HOME: ${resolveOriginalCodexHome()}`);
  try {
    await runPhaseInChild("bind", nextOptions);
    await runPhaseInChild("restart", nextOptions);
    await runPhaseInChild("detach", nextOptions);
    await runPhaseInChild("final", nextOptions);
    const report = await loadReport(tmpRoot);
    console.log("\nSummary:");
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    console.error(`Smoke temp root preserved at: ${tmpRoot}`);
    process.exitCode = 1;
    return;
  }
  if (options.keepTemp) {
    log(`kept temporary root at ${tmpRoot}`);
    return;
  }
  await fsp.rm(tmpRoot, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
