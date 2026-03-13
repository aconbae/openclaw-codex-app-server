import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  PluginCommandContext,
  PluginInteractiveButtons,
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveTelegramHandlerContext,
  ReplyPayload,
  ConversationRef,
} from "openclaw/plugin-sdk";
import { resolvePluginSettings, resolveWorkspaceDir } from "./config.js";
import { CodexAppServerClient, type ActiveCodexRun, isMissingThreadError } from "./client.js";
import {
  formatAccountSummary,
  formatBinding,
  formatBoundThreadSummary,
  formatCodexStatusText,
  formatExperimentalFeatures,
  formatMcpServers,
  formatModels,
  formatProjectPickerIntro,
  formatReviewCompletion,
  formatSkills,
  formatThreadButtonLabel,
  formatThreadPickerIntro,
  formatThreadState,
  formatTurnCompletion,
} from "./format.js";
import { requestToken } from "./pending-input.js";
import {
  buildConversationKey,
  buildPluginSessionKey,
  PluginStateStore,
} from "./state.js";
import {
  parseThreadSelectionArgs,
  selectThreadFromMatches,
} from "./thread-selection.js";
import {
  filterThreadsByProjectName,
  getProjectName,
  listProjects,
  paginateItems,
} from "./thread-picker.js";
import {
  INTERACTIVE_NAMESPACE,
  PLUGIN_ID,
  type CallbackAction,
  type ConversationTarget,
  type PendingInputState,
  type StoredBinding,
  type StoredPendingRequest,
} from "./types.js";

type ActiveRunRecord = {
  conversation: ConversationTarget;
  workspaceDir: string;
  handle: ActiveCodexRun;
};

const execFileAsync = promisify(execFile);

type PickerRender = {
  text: string;
  buttons: PluginInteractiveButtons | undefined;
};

type PickerResponders = {
  conversation: ConversationTarget;
  clear: () => Promise<void>;
  reply: (text: string) => Promise<void>;
  editPicker: (picker: PickerRender) => Promise<void>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isTelegramChannel(channel: string): boolean {
  return channel.trim().toLowerCase() === "telegram";
}

function isDiscordChannel(channel: string): boolean {
  return channel.trim().toLowerCase() === "discord";
}

function normalizeTelegramChatId(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("telegram:")) {
    return trimmed.slice("telegram:".length);
  }
  return trimmed;
}

function normalizeDiscordConversationId(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("discord:")) {
    return trimmed.slice("discord:".length);
  }
  return trimmed;
}

function toConversationTargetFromCommand(ctx: PluginCommandContext): ConversationTarget | null {
  if (isTelegramChannel(ctx.channel)) {
    const chatId = normalizeTelegramChatId(ctx.to ?? ctx.from ?? ctx.senderId);
    if (!chatId) {
      return null;
    }
    return {
      channel: "telegram",
      accountId: ctx.accountId ?? "default",
      conversationId:
        typeof ctx.messageThreadId === "number" ? `${chatId}:topic:${ctx.messageThreadId}` : chatId,
      parentConversationId: typeof ctx.messageThreadId === "number" ? chatId : undefined,
      threadId: ctx.messageThreadId,
    };
  }
  if (isDiscordChannel(ctx.channel)) {
    const conversationId = normalizeDiscordConversationId(ctx.to ?? ctx.from);
    if (!conversationId) {
      return null;
    }
    return {
      channel: "discord",
      accountId: ctx.accountId ?? "default",
      conversationId,
    };
  }
  return null;
}

function toConversationTargetFromInbound(event: {
  channel: string;
  accountId?: string;
  conversationId?: string;
  parentConversationId?: string;
  threadId?: string | number;
}): ConversationTarget | null {
  if (!event.accountId || !event.conversationId) {
    return null;
  }
  return {
    channel: event.channel.trim().toLowerCase(),
    accountId: event.accountId,
    conversationId: event.conversationId,
    parentConversationId: event.parentConversationId,
    threadId:
      typeof event.threadId === "number"
        ? event.threadId
        : typeof event.threadId === "string"
          ? Number.isFinite(Number(event.threadId))
            ? Number(event.threadId)
            : undefined
          : undefined,
  };
}

function buildReplyWithButtons(text: string, buttons?: PluginInteractiveButtons): ReplyPayload {
  return buttons
    ? {
        text,
        channelData: {
          telegram: {
            buttons,
          },
        },
      }
    : { text };
}

export class CodexPluginController {
  private readonly settings;
  private readonly client;
  private readonly activeRuns = new Map<string, ActiveRunRecord>();
  private readonly threadChangesCache = new Map<string, Promise<boolean | undefined>>();
  private readonly store;
  private serviceWorkspaceDir?: string;
  private started = false;

  constructor(private readonly api: OpenClawPluginApi) {
    this.settings = resolvePluginSettings(this.api.pluginConfig);
    this.client = new CodexAppServerClient(this.settings, this.api.logger);
    this.store = new PluginStateStore(this.api.runtime.state.resolveStateDir());
  }

  createService(): OpenClawPluginService {
    return {
      id: `${PLUGIN_ID}-service`,
      start: async (ctx) => {
        this.serviceWorkspaceDir = ctx.workspaceDir;
        await this.start();
      },
    };
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.store.load();
    await this.reconcileBindings();
    this.started = true;
  }

  async handleInboundClaim(event: {
    content: string;
    channel: string;
    accountId?: string;
    conversationId?: string;
    parentConversationId?: string;
    threadId?: string | number;
  }): Promise<{ handled: boolean }> {
    if (!this.settings.enabled) {
      return { handled: false };
    }
    await this.start();
    const conversation = toConversationTargetFromInbound(event);
    if (!conversation) {
      return { handled: false };
    }
    const activeKey = buildConversationKey(conversation);
    const active = this.activeRuns.get(activeKey);
    if (active) {
      const handled = await active.handle.queueMessage(event.content);
      return { handled };
    }
    const binding = this.store.getBinding(conversation);
    if (!binding) {
      return { handled: false };
    }
    await this.startTurn({
      conversation,
      binding,
      workspaceDir: binding.workspaceDir,
      prompt: event.content,
      reason: "inbound",
    });
    return { handled: true };
  }

  async handleTelegramInteractive(ctx: PluginInteractiveTelegramHandlerContext): Promise<void> {
    await this.start();
    const callback = this.store.getCallback(ctx.callback.payload);
    if (!callback) {
      await ctx.respond.reply({ text: "That Codex action expired. Please retry the command." });
      return;
    }
    await this.dispatchCallbackAction(callback, {
      conversation: {
        channel: "telegram",
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        parentConversationId: ctx.parentConversationId,
        threadId: ctx.threadId,
      },
      clear: async () => {
        await ctx.respond.clearButtons().catch(() => undefined);
      },
      reply: async (text) => {
        await ctx.respond.reply({ text });
      },
      editPicker: async (picker) => {
        await ctx.respond.editMessage({
          text: picker.text,
          buttons: picker.buttons,
        });
      },
    });
  }

  async handleDiscordInteractive(ctx: PluginInteractiveDiscordHandlerContext): Promise<void> {
    await this.start();
    const callback = this.store.getCallback(ctx.interaction.payload);
    if (!callback) {
      await ctx.respond.reply({ text: "That Codex action expired. Please retry the command.", ephemeral: true });
      return;
    }
    await this.dispatchCallbackAction(callback, {
      conversation: {
        channel: "discord",
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        parentConversationId: ctx.parentConversationId,
      },
      clear: async () => {
        await ctx.respond.clearComponents().catch(() => undefined);
      },
      reply: async (text) => {
        await ctx.respond.reply({ text, ephemeral: true });
      },
      editPicker: async (picker) => {
        await ctx.respond.editMessage({
          text: picker.text,
          components: this.toDiscordComponents(picker.buttons),
        });
      },
    });
  }

  async handleCommand(commandName: string, ctx: PluginCommandContext): Promise<ReplyPayload> {
    await this.start();
    const conversation = toConversationTargetFromCommand(ctx);
    const binding = conversation ? this.store.getBinding(conversation) : null;
    const args = ctx.args?.trim() ?? "";

    switch (commandName) {
      case "codex_resume":
        return await this.handleJoinCommand(conversation, binding, args, ctx.channel);
      case "codex_detach":
        if (!conversation) {
          return { text: "This command needs a Telegram or Discord conversation." };
        }
        await this.unbindConversation(conversation);
        return { text: "Detached this conversation from Codex." };
      case "codex_status":
        return await this.handleStatusCommand(binding);
      case "codex_stop":
        return await this.handleStopCommand(conversation);
      case "codex_plan":
        return await this.handlePlanCommand(conversation, binding, args);
      case "codex_review":
        return await this.handleReviewCommand(conversation, binding, args);
      case "codex_compact":
        return await this.handleCompactCommand(conversation, binding);
      case "codex_skills":
        return await this.handleSkillsCommand(binding);
      case "codex_experimental":
        return await this.handleExperimentalCommand(binding);
      case "codex_mcp":
        return await this.handleMcpCommand(binding);
      case "codex_fast":
        return await this.handleFastCommand(binding);
      case "codex_model":
        return await this.handleModelCommand(binding, args);
      case "codex_permissions":
        return await this.handlePermissionsCommand(binding);
      case "codex_init":
        return await this.handlePromptAlias(conversation, binding, args, "/init");
      case "codex_diff":
        return await this.handlePromptAlias(conversation, binding, args, "/diff");
      case "codex_rename":
        return await this.handleRenameCommand(conversation, binding, args);
      default:
        return { text: "Unknown Codex command." };
    }
  }

  private async handleListCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    filter: string,
    channel: string,
  ): Promise<ReplyPayload> {
    const parsed = parseThreadSelectionArgs(filter);
    if (!conversation) {
      return { text: "This command needs a Telegram or Discord conversation." };
    }
    const picker = parsed.listProjects
      ? await this.renderProjectPicker(conversation, binding, parsed, 0)
      : await this.renderThreadPicker(conversation, binding, parsed, 0);
    if (isDiscordChannel(channel) && picker.buttons) {
      await this.sendDiscordPicker(conversation, picker);
      return { text: "Sent a Codex thread picker to this Discord conversation." };
    }
    return buildReplyWithButtons(picker.text, picker.buttons);
  }

  private async handleJoinCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    args: string,
    channel: string,
  ): Promise<ReplyPayload> {
    if (!conversation) {
      return { text: "This command needs a Telegram or Discord conversation." };
    }
    const parsed = parseThreadSelectionArgs(args);
    if (parsed.listProjects || !parsed.query) {
      const passthroughArgs = [
        parsed.includeAll ? "--all" : "",
        parsed.listProjects ? "--projects" : "",
        parsed.cwd ? `--cwd ${parsed.cwd}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return await this.handleListCommand(conversation, binding, passthroughArgs, channel);
    }
    const workspaceDir = this.resolveThreadWorkspaceDir(parsed, binding, false);
    const selection = await this.resolveSingleThread(
      binding?.sessionKey,
      workspaceDir,
      parsed.query,
    );
    if (selection.kind === "none") {
      return { text: `No Codex thread matched "${parsed.query}".` };
    }
    if (selection.kind === "ambiguous") {
      const picker = await this.renderThreadPicker(conversation, binding, parsed, 0);
      if (isDiscordChannel(channel) && picker.buttons) {
        await this.sendDiscordPicker(conversation, picker);
        return {
          text: `Multiple Codex threads matched "${parsed.query}". Sent a picker to this Discord conversation.`,
        };
      }
      return buildReplyWithButtons(picker.text, picker.buttons);
    }
    await this.bindConversation(conversation, {
      threadId: selection.thread.threadId,
      workspaceDir:
        selection.thread.projectKey ||
        workspaceDir ||
        resolveWorkspaceDir({
          bindingWorkspaceDir: binding?.workspaceDir,
          configuredWorkspaceDir: this.settings.defaultWorkspaceDir,
          serviceWorkspaceDir: this.serviceWorkspaceDir,
      }),
      threadTitle: selection.thread.title,
    });
    await this.sendBoundConversationSummary(conversation);
    return { text: "" };
  }

  private async handleStatusCommand(binding: StoredBinding | null): Promise<ReplyPayload> {
    return {
      text: await this.buildStatusText(binding),
    };
  }

  private async handleStopCommand(conversation: ConversationTarget | null): Promise<ReplyPayload> {
    if (!conversation) {
      return { text: "This command needs a Telegram or Discord conversation." };
    }
    const active = this.activeRuns.get(buildConversationKey(conversation));
    if (!active) {
      return { text: "No active Codex run for this conversation." };
    }
    await active.handle.interrupt();
    return { text: "Stopping Codex." };
  }

  private async handlePlanCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    args: string,
  ): Promise<ReplyPayload> {
    if (!conversation) {
      return { text: "This command needs a Telegram or Discord conversation." };
    }
    const prompt = args.trim();
    if (!prompt) {
      return { text: "Usage: /codex_plan <goal>" };
    }
    const workspaceDir = resolveWorkspaceDir({
      bindingWorkspaceDir: binding?.workspaceDir,
      configuredWorkspaceDir: this.settings.defaultWorkspaceDir,
      serviceWorkspaceDir: this.serviceWorkspaceDir,
    });
    await this.startTurn({
      conversation,
      binding,
      workspaceDir,
      prompt: `Create an action plan for this request and do not execute changes yet:\n\n${prompt}`,
      reason: "plan",
    });
    return { text: "Codex is drafting a plan." };
  }

  private async handleReviewCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    args: string,
  ): Promise<ReplyPayload> {
    if (!conversation || !binding) {
      return { text: "Bind this conversation to a Codex thread before running review." };
    }
    const workspaceDir = binding.workspaceDir;
    await this.startReview({
      conversation,
      binding,
      workspaceDir,
      target: args.trim()
        ? { type: "custom", instructions: args.trim() }
        : { type: "uncommittedChanges" },
    });
    return { text: "Codex review started." };
  }

  private async handleCompactCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
  ): Promise<ReplyPayload> {
    if (!conversation || !binding) {
      return { text: "Bind this conversation to a Codex thread before compacting it." };
    }
    const typing = await this.startTypingLease(conversation);
    try {
      await this.sendText(conversation, "Compacting the Codex thread...");
      const result = await this.client.compactThread({
        sessionKey: binding.sessionKey,
        threadId: binding.threadId,
      });
      await this.sendText(
        conversation,
        result.usage?.remainingPercent != null
          ? `Codex compacted the thread. Context remaining: ${result.usage.remainingPercent}%.`
          : "Codex compacted the thread.",
      );
      if (result.usage) {
        await this.store.upsertBinding({
          ...binding,
          contextUsage: result.usage,
          updatedAt: Date.now(),
        });
      }
      return { text: "Codex compaction started and the follow-up message was sent." };
    } finally {
      typing?.stop();
    }
  }

  private async handleSkillsCommand(binding: StoredBinding | null): Promise<ReplyPayload> {
    const skills = await this.client.listSkills({
      sessionKey: binding?.sessionKey,
      workspaceDir: binding?.workspaceDir,
    });
    return { text: formatSkills(skills) };
  }

  private async handleExperimentalCommand(binding: StoredBinding | null): Promise<ReplyPayload> {
    const features = await this.client.listExperimentalFeatures({
      sessionKey: binding?.sessionKey,
    });
    return { text: formatExperimentalFeatures(features) };
  }

  private async handleMcpCommand(binding: StoredBinding | null): Promise<ReplyPayload> {
    const servers = await this.client.listMcpServers({
      sessionKey: binding?.sessionKey,
    });
    return { text: formatMcpServers(servers) };
  }

  private async handleFastCommand(binding: StoredBinding | null): Promise<ReplyPayload> {
    if (!binding) {
      return { text: "Bind this conversation to a Codex thread before toggling fast mode." };
    }
    const state = await this.client.readThreadState({
      sessionKey: binding.sessionKey,
      threadId: binding.threadId,
    });
    const nextTier = state.serviceTier === "priority" ? null : "priority";
    const updated = await this.client.setThreadServiceTier({
      sessionKey: binding.sessionKey,
      threadId: binding.threadId,
      serviceTier: nextTier,
    });
    return {
      text:
        updated.serviceTier === "priority"
          ? "Codex Fast mode enabled."
          : "Codex Fast mode disabled.",
    };
  }

  private async handleModelCommand(
    binding: StoredBinding | null,
    args: string,
  ): Promise<ReplyPayload> {
    if (!binding) {
      const models = await this.client.listModels({});
      return { text: formatModels(models) };
    }
    if (!args.trim()) {
      const [models, state] = await Promise.all([
        this.client.listModels({ sessionKey: binding.sessionKey }),
        this.client.readThreadState({
          sessionKey: binding.sessionKey,
          threadId: binding.threadId,
        }),
      ]);
      return { text: formatModels(models, state) };
    }
    const state = await this.client.setThreadModel({
      sessionKey: binding.sessionKey,
      threadId: binding.threadId,
      model: args.trim(),
      workspaceDir: binding.workspaceDir,
    });
    return { text: `Codex model set to ${state.model || args.trim()}.` };
  }

  private async handlePermissionsCommand(binding: StoredBinding | null): Promise<ReplyPayload> {
    if (!binding) {
      const [account, limits] = await Promise.all([
        this.client.readAccount({}),
        this.client.readRateLimits({}),
      ]);
      return { text: formatAccountSummary(account, limits) };
    }
    const [state, account, limits] = await Promise.all([
      this.client.readThreadState({
        sessionKey: binding.sessionKey,
        threadId: binding.threadId,
      }),
      this.client.readAccount({ sessionKey: binding.sessionKey }),
      this.client.readRateLimits({ sessionKey: binding.sessionKey }),
    ]);
    return {
      text:
        `${formatThreadState(state, binding)}\n\n${formatAccountSummary(account, limits)}`.trim(),
    };
  }

  private async handlePromptAlias(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    args: string,
    alias: string,
  ): Promise<ReplyPayload> {
    if (!conversation) {
      return { text: "This command needs a Telegram or Discord conversation." };
    }
    const workspaceDir = resolveWorkspaceDir({
      bindingWorkspaceDir: binding?.workspaceDir,
      configuredWorkspaceDir: this.settings.defaultWorkspaceDir,
      serviceWorkspaceDir: this.serviceWorkspaceDir,
    });
    await this.startTurn({
      conversation,
      binding,
      workspaceDir,
      prompt: `${alias}${args.trim() ? ` ${args.trim()}` : ""}`,
      reason: "command",
    });
    return { text: `Sent ${alias} to Codex.` };
  }

  private async handleRenameCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    args: string,
  ): Promise<ReplyPayload> {
    if (!conversation || !binding) {
      return { text: "Bind this conversation to a Codex thread before renaming it." };
    }
    const name = args.trim();
    if (!name) {
      return { text: "Usage: /codex_rename <new name>" };
    }
    await this.client.setThreadName({
      sessionKey: binding.sessionKey,
      threadId: binding.threadId,
      name,
    });
    await this.renameConversationIfSupported(conversation, name);
    await this.store.upsertBinding({
      ...binding,
      threadTitle: name,
      updatedAt: Date.now(),
    });
    return { text: `Renamed the Codex thread to "${name}".` };
  }

  private async startTurn(params: {
    conversation: ConversationTarget;
    binding: StoredBinding | null;
    workspaceDir: string;
    prompt: string;
    reason: "command" | "inbound" | "plan";
  }): Promise<void> {
    const key = buildConversationKey(params.conversation);
    const existing = this.activeRuns.get(key);
    if (existing) {
      await existing.handle.queueMessage(params.prompt);
      return;
    }
    const typing = await this.startTypingLease(params.conversation);
    const run = this.client.startTurn({
      sessionKey: params.binding?.sessionKey,
      workspaceDir: params.workspaceDir,
      prompt: params.prompt,
      runId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      existingThreadId: params.binding?.threadId,
      model: this.settings.defaultModel,
      onPendingInput: async (state) => {
        await this.handlePendingInputState(params.conversation, params.workspaceDir, state, run);
      },
      onInterrupted: async () => {
        await this.sendText(params.conversation, "Codex stopped.");
      },
    });
    this.activeRuns.set(key, {
      conversation: params.conversation,
      workspaceDir: params.workspaceDir,
      handle: run,
    });
    void (run.result as Promise<import("./types.js").TurnResult>)
      .then(async (result) => {
        const threadId = result.threadId || run.getThreadId();
        if (threadId) {
          const state = await this.client
            .readThreadState({
              sessionKey: params.binding?.sessionKey,
              threadId,
            })
            .catch(() => null);
          const nextBinding = await this.bindConversation(params.conversation, {
            threadId,
            workspaceDir: state?.cwd || params.workspaceDir,
            threadTitle: state?.threadName,
          });
          if (state?.threadName && nextBinding.threadTitle !== state.threadName) {
            await this.store.upsertBinding({
              ...nextBinding,
              threadTitle: state.threadName,
              contextUsage: result.usage ?? nextBinding.contextUsage,
              updatedAt: Date.now(),
            });
          } else if (result.usage) {
            await this.store.upsertBinding({
              ...nextBinding,
              contextUsage: result.usage,
              updatedAt: Date.now(),
            });
          }
        }
        await this.sendText(params.conversation, formatTurnCompletion(result));
      })
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await this.sendText(params.conversation, `Codex failed: ${message}`);
      })
      .finally(async () => {
        typing?.stop();
        this.activeRuns.delete(key);
        const pending = this.store.getPendingRequestByConversation(params.conversation);
        if (pending) {
          await this.store.removePendingRequest(pending.requestId);
        }
      });
  }

  private async startReview(params: {
    conversation: ConversationTarget;
    binding: StoredBinding;
    workspaceDir: string;
    target: { type: "uncommittedChanges" } | { type: "custom"; instructions: string };
  }): Promise<void> {
    const key = buildConversationKey(params.conversation);
    const existing = this.activeRuns.get(key);
    if (existing) {
      await existing.handle.interrupt();
    }
    const typing = await this.startTypingLease(params.conversation);
    const run = this.client.startReview({
      sessionKey: params.binding.sessionKey,
      workspaceDir: params.workspaceDir,
      threadId: params.binding.threadId,
      runId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      target: params.target,
      onPendingInput: async (state) => {
        await this.handlePendingInputState(params.conversation, params.workspaceDir, state, run);
      },
      onInterrupted: async () => {
        await this.sendText(params.conversation, "Codex review stopped.");
      },
    });
    this.activeRuns.set(key, {
      conversation: params.conversation,
      workspaceDir: params.workspaceDir,
      handle: run,
    });
    void (run.result as Promise<import("./types.js").ReviewResult>)
      .then(async (result) => {
        await this.sendText(params.conversation, formatReviewCompletion(result));
      })
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await this.sendText(params.conversation, `Codex review failed: ${message}`);
      })
      .finally(async () => {
        typing?.stop();
        this.activeRuns.delete(key);
        const pending = this.store.getPendingRequestByConversation(params.conversation);
        if (pending) {
          await this.store.removePendingRequest(pending.requestId);
        }
      });
  }

  private async handlePendingInputState(
    conversation: ConversationTarget,
    workspaceDir: string,
    state: PendingInputState | null,
    run: ActiveCodexRun,
  ): Promise<void> {
    if (!state) {
      const existing = this.store.getPendingRequestByConversation(conversation);
      if (existing) {
        await this.store.removePendingRequest(existing.requestId);
      }
      return;
    }
    const callbacks = await Promise.all(
      (state.actions ?? []).map(async (_action, actionIndex) => {
        return await this.store.putCallback({
          kind: "pending-input",
          conversation,
          requestId: state.requestId,
          actionIndex,
          ttlMs: Math.max(1_000, state.expiresAt - Date.now()),
        });
      }),
    );
    const buttons = this.buildPendingButtons(state, callbacks);
    await this.store.upsertPendingRequest({
      requestId: state.requestId,
      conversation,
      threadId: run.getThreadId() ?? this.store.getBinding(conversation)?.threadId ?? "",
      workspaceDir,
      state,
      updatedAt: Date.now(),
    });
    await this.sendText(conversation, state.promptText ?? "Codex needs input.", { buttons });
  }

  private buildPendingButtons(
    state: PendingInputState,
    callbacks: CallbackAction[],
  ): PluginInteractiveButtons | undefined {
    const actions = state.actions ?? [];
    if (actions.length === 0 || callbacks.length === 0) {
      return undefined;
    }
    const rows: PluginInteractiveButtons = [];
    for (let index = 0; index < actions.length; index += 2) {
      rows.push(
        actions.slice(index, index + 2).map((action, offset) => ({
          text: action.label,
          callback_data: `${INTERACTIVE_NAMESPACE}:${callbacks[index + offset]?.token ?? requestToken(state.requestId)}`,
        })),
      );
    }
    return rows;
  }

  private resolveThreadWorkspaceDir(
    parsed: ReturnType<typeof parseThreadSelectionArgs>,
    binding: StoredBinding | null,
    useAllProjectsDefault: boolean,
  ): string | undefined {
    if (parsed.cwd) {
      return parsed.cwd;
    }
    if (parsed.includeAll || useAllProjectsDefault) {
      return undefined;
    }
    return resolveWorkspaceDir({
      bindingWorkspaceDir: binding?.workspaceDir,
      configuredWorkspaceDir: this.settings.defaultWorkspaceDir,
      serviceWorkspaceDir: this.serviceWorkspaceDir,
    });
  }

  private async listPickerThreads(
    binding: StoredBinding | null,
    params: {
      parsed: ReturnType<typeof parseThreadSelectionArgs>;
      projectName?: string;
      filterProjectsOnly?: boolean;
    },
  ) {
    const workspaceDir = this.resolveThreadWorkspaceDir(
      params.parsed,
      binding,
      params.filterProjectsOnly || Boolean(params.projectName),
    );
    const threads = await this.client.listThreads({
      sessionKey: binding?.sessionKey,
      workspaceDir,
      filter: params.filterProjectsOnly ? undefined : params.parsed.query || undefined,
    });
    return {
      workspaceDir,
      threads: filterThreadsByProjectName(threads, params.projectName),
    };
  }

  private async buildThreadPickerButtons(params: {
    conversation: ConversationTarget;
    threads: Array<{ threadId: string; title?: string; projectKey?: string }>;
    showProjectName: boolean;
  }): Promise<PluginInteractiveButtons | undefined> {
    if (params.threads.length === 0) {
      return undefined;
    }
    const rows: PluginInteractiveButtons = [];
    for (const thread of params.threads) {
      const isWorktree = this.isWorktreePath(thread.projectKey);
      const hasChanges = await this.readThreadHasChanges(thread.projectKey);
      const callback = await this.store.putCallback({
        kind: "resume-thread",
        conversation: params.conversation,
        threadId: thread.threadId,
        workspaceDir: thread.projectKey?.trim() || this.settings.defaultWorkspaceDir || process.cwd(),
      });
      rows.push([
        {
          text: formatThreadButtonLabel({
            thread,
            includeProjectSuffix: params.showProjectName,
            isWorktree,
            hasChanges,
          }),
          callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
        },
      ]);
    }
    return rows;
  }

  private async appendThreadPickerControls(params: {
    conversation: ConversationTarget;
    buttons: PluginInteractiveButtons;
    parsed: ReturnType<typeof parseThreadSelectionArgs>;
    projectName?: string;
    page: number;
    totalPages: number;
  }): Promise<PluginInteractiveButtons> {
    if (params.totalPages > 1) {
      const navRow: PluginInteractiveButtons[number] = [];
      if (params.page > 0) {
        const prev = await this.store.putCallback({
          kind: "picker-view",
          conversation: params.conversation,
          view: {
            mode: "threads",
            includeAll: params.parsed.includeAll,
            workspaceDir: params.parsed.cwd,
            query: params.parsed.query || undefined,
            projectName: params.projectName,
            page: params.page - 1,
          },
        });
        navRow.push({
          text: "◀ Prev",
          callback_data: `${INTERACTIVE_NAMESPACE}:${prev.token}`,
        });
      }
      if (params.page + 1 < params.totalPages) {
        const next = await this.store.putCallback({
          kind: "picker-view",
          conversation: params.conversation,
          view: {
            mode: "threads",
            includeAll: params.parsed.includeAll,
            workspaceDir: params.parsed.cwd,
            query: params.parsed.query || undefined,
            projectName: params.projectName,
            page: params.page + 1,
          },
        });
        navRow.push({
          text: "Next ▶",
          callback_data: `${INTERACTIVE_NAMESPACE}:${next.token}`,
        });
      }
      if (navRow.length > 0) {
        params.buttons.push(navRow);
      }
    }

    const projects = await this.store.putCallback({
      kind: "picker-view",
      conversation: params.conversation,
      view: {
        mode: "projects",
        includeAll: true,
        workspaceDir: params.parsed.cwd,
        page: 0,
      },
    });
    params.buttons.push([
      {
        text: params.projectName ? "Projects" : "Browse Projects",
        callback_data: `${INTERACTIVE_NAMESPACE}:${projects.token}`,
      },
    ]);
    return params.buttons;
  }

  private async renderThreadPicker(
    conversation: ConversationTarget,
    binding: StoredBinding | null,
    parsed: ReturnType<typeof parseThreadSelectionArgs>,
    page: number,
    projectName?: string,
  ): Promise<PickerRender> {
    const { workspaceDir, threads } = await this.listPickerThreads(binding, {
      parsed,
      projectName,
    });
    const pageResult = paginateItems(threads, page);
    const distinctProjects = new Set(
      threads.map((thread) => getProjectName(thread.projectKey)).filter(Boolean),
    );
    const threadButtons =
      (await this.buildThreadPickerButtons({
      conversation,
      threads: pageResult.items,
      showProjectName: !projectName && distinctProjects.size > 1,
      })) ?? [];
    return {
      text: formatThreadPickerIntro({
        page: pageResult.page,
        totalPages: pageResult.totalPages,
        totalItems: pageResult.totalItems,
        includeAll: workspaceDir == null,
        workspaceDir,
        projectName,
      }),
      buttons: await this.appendThreadPickerControls({
            conversation,
            buttons: threadButtons,
            parsed,
            projectName,
            page: pageResult.page,
            totalPages: pageResult.totalPages,
          }),
    };
  }

  private async renderProjectPicker(
    conversation: ConversationTarget,
    binding: StoredBinding | null,
    parsed: ReturnType<typeof parseThreadSelectionArgs>,
    page: number,
  ): Promise<PickerRender> {
    const { workspaceDir, threads } = await this.listPickerThreads(binding, {
      parsed,
      filterProjectsOnly: true,
    });
    const projects = paginateItems(listProjects(threads, parsed.query), page);
    const buttons: PluginInteractiveButtons = [];
    for (const project of projects.items) {
      const callback = await this.store.putCallback({
        kind: "picker-view",
        conversation,
        view: {
          mode: "threads",
          includeAll: true,
          workspaceDir: parsed.cwd,
          projectName: project.name,
          page: 0,
        },
      });
      buttons.push([
        {
          text: `${project.name} (${project.threadCount})`,
          callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
        },
      ]);
    }

    if (projects.totalPages > 1) {
      const navRow: PluginInteractiveButtons[number] = [];
      if (projects.page > 0) {
        const prev = await this.store.putCallback({
          kind: "picker-view",
          conversation,
          view: {
            mode: "projects",
            includeAll: true,
            workspaceDir: parsed.cwd,
            query: parsed.query || undefined,
            page: projects.page - 1,
          },
        });
        navRow.push({
          text: "◀ Prev",
          callback_data: `${INTERACTIVE_NAMESPACE}:${prev.token}`,
        });
      }
      if (projects.page + 1 < projects.totalPages) {
        const next = await this.store.putCallback({
          kind: "picker-view",
          conversation,
          view: {
            mode: "projects",
            includeAll: true,
            workspaceDir: parsed.cwd,
            query: parsed.query || undefined,
            page: projects.page + 1,
          },
        });
        navRow.push({
          text: "Next ▶",
          callback_data: `${INTERACTIVE_NAMESPACE}:${next.token}`,
        });
      }
      if (navRow.length > 0) {
        buttons.push(navRow);
      }
    }

    const recent = await this.store.putCallback({
      kind: "picker-view",
      conversation,
      view: {
        mode: "threads",
        includeAll: true,
        workspaceDir: parsed.cwd,
        page: 0,
      },
    });
    buttons.push([
      {
        text: "Recent Sessions",
        callback_data: `${INTERACTIVE_NAMESPACE}:${recent.token}`,
      },
    ]);

    return {
      text: formatProjectPickerIntro({
        page: projects.page,
        totalPages: projects.totalPages,
        totalItems: projects.totalItems,
        workspaceDir,
      }),
      buttons,
    };
  }

  private toDiscordComponents(buttons: PluginInteractiveButtons | undefined): unknown[] | undefined {
    if (!buttons || buttons.length === 0) {
      return undefined;
    }
    return buttons.map((row) => ({
      type: 1,
      components: row.map((button) => ({
        type: 2,
        style: 1,
        label: button.text,
        custom_id: button.callback_data,
      })),
    }));
  }

  private async sendDiscordPicker(
    conversation: ConversationTarget,
    picker: PickerRender,
  ): Promise<void> {
    await this.api.runtime.channel.discord.sendComponentMessage(
      conversation.conversationId,
      {
        text: picker.text,
        blocks: (picker.buttons ?? []).map((row) => ({
          type: "actions" as const,
          buttons: row.map((button) => ({
            label: button.text,
            style: "primary" as const,
            callbackData: button.callback_data,
          })),
        })),
      },
      {
        accountId: conversation.accountId,
      },
    );
  }

  private async dispatchCallbackAction(
    callback: CallbackAction,
    responders: PickerResponders,
  ): Promise<void> {
    if (callback.kind === "resume-thread") {
      await responders.clear().catch(() => undefined);
      await this.bindConversation(callback.conversation, {
        threadId: callback.threadId,
        workspaceDir: callback.workspaceDir,
      });
      await this.store.removeCallback(callback.token);
      await this.sendBoundConversationSummary(callback.conversation);
      return;
    }
    if (callback.kind === "pending-input") {
      await responders.clear().catch(() => undefined);
      const pending = this.store.getPendingRequestById(callback.requestId);
      if (!pending || pending.state.expiresAt <= Date.now()) {
        await this.store.removeCallback(callback.token);
        await responders.reply("That Codex request expired. Please retry.");
        return;
      }
      const active = this.activeRuns.get(buildConversationKey(callback.conversation));
      if (!active) {
        await responders.reply("No active Codex run is waiting for input.");
        return;
      }
      const submitted = await active.handle.submitPendingInput(callback.actionIndex);
      if (!submitted) {
        await responders.reply("That Codex action is no longer available.");
        return;
      }
      await this.store.removeCallback(callback.token);
      await responders.reply("Sent to Codex.");
      return;
    }
    const binding = this.store.getBinding(callback.conversation);
    await this.store.removeCallback(callback.token);
    const parsed = {
      includeAll: callback.view.includeAll,
      listProjects: callback.view.mode === "projects",
      cwd: callback.view.workspaceDir,
      query: callback.view.query ?? "",
    };
    const picker =
      callback.view.mode === "projects"
        ? await this.renderProjectPicker(responders.conversation, binding, parsed, callback.view.page)
        : await this.renderThreadPicker(
            responders.conversation,
            binding,
            parsed,
            callback.view.page,
            callback.view.projectName,
          );
    await responders.editPicker(picker);
  }

  private async resolveSingleThread(
    sessionKey: string | undefined,
    workspaceDir: string | undefined,
    filter: string,
  ): Promise<
    | { kind: "none" }
    | { kind: "unique"; thread: { threadId: string; title?: string; projectKey?: string } }
    | { kind: "ambiguous"; threads: Array<{ threadId: string; title?: string; projectKey?: string }> }
  > {
    const trimmed = filter.trim();
    const threads = await this.client.listThreads({
      sessionKey,
      workspaceDir,
      filter: trimmed,
    });
    return selectThreadFromMatches(threads, trimmed);
  }

  private async bindConversation(
    conversation: ConversationTarget,
    params: {
      threadId: string;
      workspaceDir: string;
      threadTitle?: string;
    },
  ): Promise<StoredBinding> {
    const sessionKey = buildPluginSessionKey(params.threadId);
    const record: StoredBinding = {
      conversation: {
        channel: conversation.channel,
        accountId: conversation.accountId,
        conversationId: conversation.conversationId,
        parentConversationId: conversation.parentConversationId,
      },
      sessionKey,
      threadId: params.threadId,
      workspaceDir: params.workspaceDir,
      threadTitle: params.threadTitle,
      contextUsage: this.store.getBinding(conversation)?.contextUsage,
      updatedAt: Date.now(),
    };
    const existing = this.api.runtime.channel.bindings.resolveByConversation(record.conversation);
    if (!existing) {
      try {
        await this.api.runtime.channel.bindings.bind({
          targetSessionKey: sessionKey,
          targetKind: "session",
          conversation: record.conversation,
          placement: "current",
          metadata: {
            pluginId: PLUGIN_ID,
            threadId: params.threadId,
            workspaceDir: params.workspaceDir,
          },
        });
      } catch (error) {
        this.api.logger.warn(`codex binding bridge bind failed: ${String(error)}`);
      }
    }
    await this.store.upsertBinding(record);
    return record;
  }

  private trimReplayText(value?: string, maxLength = 1200): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.length <= maxLength) {
      return trimmed;
    }
    return `${trimmed.slice(0, maxLength - 3).trimEnd()}...`;
  }

  private isWorktreePath(projectKey?: string): boolean {
    const trimmed = projectKey?.trim();
    return Boolean(trimmed && /[/\\]worktrees[/\\][^/\\]+[/\\][^/\\]+/.test(trimmed));
  }

  private readThreadHasChanges(projectKey?: string): Promise<boolean | undefined> {
    const cwd = projectKey?.trim();
    if (!cwd) {
      return Promise.resolve(undefined);
    }
    let cached = this.threadChangesCache.get(cwd);
    if (!cached) {
      cached = execFileAsync("git", ["-C", cwd, "status", "--porcelain"], {
        timeout: 5_000,
      })
        .then((result) => result.stdout.trim().length > 0)
        .catch(() => undefined);
      this.threadChangesCache.set(cwd, cached);
    }
    return cached;
  }

  private async buildBoundConversationMessages(
    conversation: ConversationTarget | ConversationRef,
  ): Promise<string[]> {
    const binding = this.store.getBinding({
      channel: conversation.channel,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
      parentConversationId: conversation.parentConversationId,
    });
    if (!binding) {
      return ["No Codex binding for this conversation."];
    }

    const [state, replay] = await Promise.all([
      this.client.readThreadState({
        sessionKey: binding.sessionKey,
        threadId: binding.threadId,
      }),
      this.client.readThreadContext({
        sessionKey: binding.sessionKey,
        threadId: binding.threadId,
      }).catch(() => ({ lastUserMessage: undefined, lastAssistantMessage: undefined })),
    ]);

    const nextBinding =
      (state.threadName && state.threadName !== binding.threadTitle) ||
      (state.cwd?.trim() && state.cwd.trim() !== binding.workspaceDir)
        ? {
            ...binding,
            threadTitle: state.threadName?.trim() || binding.threadTitle,
            workspaceDir: state.cwd?.trim() || binding.workspaceDir,
            contextUsage: binding.contextUsage,
            updatedAt: Date.now(),
          }
        : binding;

    if (nextBinding !== binding) {
      await this.store.upsertBinding(nextBinding);
    }

    const messages = [
      formatBoundThreadSummary({
      binding: nextBinding,
      state,
      }),
    ];

    const lastUser = this.trimReplayText(replay.lastUserMessage);
    if (lastUser) {
      messages.push("Last User Request in Thread:");
      messages.push(lastUser);
    }

    const lastAssistant = this.trimReplayText(replay.lastAssistantMessage);
    if (lastAssistant) {
      messages.push("Last Agent Reply in Thread:");
      messages.push(lastAssistant);
    }

    return messages;
  }

  private async sendBoundConversationSummary(
    conversation: ConversationTarget | ConversationRef,
  ): Promise<void> {
    const messages = await this.buildBoundConversationMessages(conversation);
    const target: ConversationTarget = {
      channel: conversation.channel,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
      parentConversationId: conversation.parentConversationId,
      threadId: "threadId" in conversation ? conversation.threadId : undefined,
    };
    for (const message of messages) {
      await this.sendText(target, message);
    }
  }

  private async buildStatusText(binding: StoredBinding | null): Promise<string> {
    const workspaceDir = resolveWorkspaceDir({
      bindingWorkspaceDir: binding?.workspaceDir,
      configuredWorkspaceDir: this.settings.defaultWorkspaceDir,
      serviceWorkspaceDir: this.serviceWorkspaceDir,
    });
    const [threadState, account, limits, projectFolder] = await Promise.all([
      binding
        ? this.client.readThreadState({
            sessionKey: binding.sessionKey,
            threadId: binding.threadId,
          }).catch(() => undefined)
        : Promise.resolve(undefined),
      this.client.readAccount({
        sessionKey: binding?.sessionKey,
      }).catch(() => null),
      this.client.readRateLimits({
        sessionKey: binding?.sessionKey,
      }).catch(() => []),
      this.resolveProjectFolder(binding?.workspaceDir || workspaceDir),
    ]);

    return formatCodexStatusText({
      threadState,
      account,
      rateLimits: limits,
      bindingActive: Boolean(binding),
      projectFolder,
      worktreeFolder: threadState?.cwd?.trim() || binding?.workspaceDir || workspaceDir,
      contextUsage: binding?.contextUsage,
    });
  }

  private async resolveProjectFolder(worktreeFolder?: string): Promise<string | undefined> {
    const cwd = worktreeFolder?.trim();
    if (!cwd) {
      return undefined;
    }
    try {
      const result = await execFileAsync(
        "git",
        ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { timeout: 5_000 },
      );
      const commonDir = result.stdout.trim();
      if (!commonDir) {
        return cwd;
      }
      return path.dirname(commonDir);
    } catch {
      return cwd;
    }
  }

  private async unbindConversation(conversation: ConversationTarget): Promise<void> {
    const binding = this.store.getBinding(conversation);
    if (binding) {
      await this.api.runtime.channel.bindings
        .unbind({
          targetSessionKey: binding.sessionKey,
          reason: "plugin-detach",
        })
        .catch(() => undefined);
    }
    await this.store.removeBinding(conversation);
  }

  private async reconcileBindings(): Promise<void> {
    for (const binding of this.store.listBindings()) {
      try {
        await this.client.readThreadState({
          sessionKey: binding.sessionKey,
          threadId: binding.threadId,
        });
      } catch (error) {
        if (isMissingThreadError(error)) {
          await this.store.removeBinding(binding.conversation);
          continue;
        }
      }
      const existing = this.api.runtime.channel.bindings.resolveByConversation(binding.conversation);
      if (existing?.targetSessionKey === binding.sessionKey) {
        continue;
      }
      try {
        await this.api.runtime.channel.bindings.bind({
          targetSessionKey: binding.sessionKey,
          targetKind: "session",
          conversation: binding.conversation,
          placement: "current",
          metadata: {
            pluginId: PLUGIN_ID,
            threadId: binding.threadId,
            workspaceDir: binding.workspaceDir,
          },
        });
      } catch (error) {
        this.api.logger.warn(`codex binding reconcile failed: ${String(error)}`);
      }
    }
  }

  private async startTypingLease(conversation: ConversationTarget): Promise<{
    stop: () => void;
  } | null> {
    if (isTelegramChannel(conversation.channel)) {
      return await this.api.runtime.channel.telegram.typing.start({
        to: conversation.parentConversationId ?? conversation.conversationId,
        accountId: conversation.accountId,
        messageThreadId: conversation.threadId,
      });
    }
    if (isDiscordChannel(conversation.channel)) {
      return await this.api.runtime.channel.discord.typing.start({
        channelId: conversation.conversationId,
        accountId: conversation.accountId,
      });
    }
    return null;
  }

  private async sendText(
    conversation: ConversationTarget,
    text: string,
    opts?: { buttons?: PluginInteractiveButtons },
  ): Promise<void> {
    if (!text.trim()) {
      return;
    }
    if (isTelegramChannel(conversation.channel)) {
      await this.api.runtime.channel.telegram.sendMessageTelegram(
        conversation.parentConversationId ?? conversation.conversationId,
        text,
        {
          accountId: conversation.accountId,
          messageThreadId: conversation.threadId,
          buttons: opts?.buttons,
        },
      );
      return;
    }
    if (isDiscordChannel(conversation.channel)) {
      if (opts?.buttons && opts.buttons.length > 0) {
        await this.api.runtime.channel.discord.sendComponentMessage(
          conversation.conversationId,
          {
            text,
            blocks: opts.buttons.map((row) => ({
              type: "actions" as const,
              buttons: row.map((button) => ({
                label: button.text,
                style: "primary" as const,
                callbackData: button.callback_data,
              })),
            })),
          },
          {
            accountId: conversation.accountId,
          },
        );
        return;
      }
      await this.api.runtime.channel.discord.sendMessageDiscord(
        conversation.conversationId,
        text,
        {
          accountId: conversation.accountId,
        },
      );
    }
  }

  private async renameConversationIfSupported(
    conversation: ConversationTarget,
    name: string,
  ): Promise<void> {
    if (isTelegramChannel(conversation.channel) && conversation.threadId != null) {
      await this.api.runtime.channel.telegram.conversationActions.renameTopic(
        conversation.parentConversationId ?? conversation.conversationId,
        conversation.threadId,
        name,
        {
          accountId: conversation.accountId,
        },
      ).catch((error) => {
        this.api.logger.warn(`codex telegram topic rename failed: ${String(error)}`);
      });
      return;
    }
    if (isDiscordChannel(conversation.channel)) {
      await this.api.runtime.channel.discord.conversationActions.editChannel(
        conversation.conversationId,
        {
          name,
        },
        {
          accountId: conversation.accountId,
        },
      ).catch((error) => {
        this.api.logger.warn(`codex discord channel rename failed: ${String(error)}`);
      });
    }
  }
}
