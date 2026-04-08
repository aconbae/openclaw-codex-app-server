import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import type { OpenClawPluginApi, PluginCommandContext, ReplyPayload } from "./openclaw-types.js";
import { CodexAppServerClient } from "./client.js";
import { CodexPluginController } from "./controller.js";
import { buildPluginSessionKey } from "./state.js";
import { PLUGIN_ID } from "./types.js";

const TEST_TELEGRAM_PEER_ID = "telegram-user-1";
const sessionBindingRecords = new Map<string, Record<string, unknown>>();

type SessionBindingConversation = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
};

function normalizeSessionBindingConversation(
  conversation: SessionBindingConversation,
): SessionBindingConversation {
  if (conversation.channel !== "discord") {
    return conversation;
  }
  const normalize = (value: string | undefined): string | undefined => {
    if (!value) {
      return value;
    }
    if (value.startsWith("channel:")) {
      return value.slice("channel:".length);
    }
    if (value.startsWith("user:")) {
      return value.slice("user:".length);
    }
    if (value.startsWith("discord:channel:")) {
      return value.slice("discord:channel:".length);
    }
    if (value.startsWith("discord:user:")) {
      return value.slice("discord:user:".length);
    }
    if (value.startsWith("discord:")) {
      return value.slice("discord:".length);
    }
    return value;
  };
  return {
    ...conversation,
    conversationId: normalize(conversation.conversationId) ?? conversation.conversationId,
    parentConversationId: normalize(conversation.parentConversationId),
  };
}

function toSessionBindingKey(conversation: SessionBindingConversation): string {
  const normalized = normalizeSessionBindingConversation(conversation);
  return [
    normalized.channel.trim().toLowerCase(),
    normalized.accountId.trim(),
    normalized.conversationId.trim(),
    normalized.channel === "telegram" ? (normalized.parentConversationId?.trim() ?? "") : "",
  ].join("::");
}

function registerOwnedSessionBinding(params: {
  conversation: SessionBindingConversation;
  threadId: string;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
}): void {
  const normalizedConversation = normalizeSessionBindingConversation(params.conversation);
  sessionBindingRecords.set(toSessionBindingKey(normalizedConversation), {
    bindingId: `binding:${params.threadId}`,
    conversation: normalizedConversation,
    targetKind: "session",
    status: "active",
    boundAt: Date.now(),
    targetSessionKey: params.sessionKey ?? buildPluginSessionKey(params.threadId),
    metadata: {
      pluginId: PLUGIN_ID,
      threadId: params.threadId,
      ...(params.metadata ?? {}),
    },
  });
}

function registerOwnedSessionBindingForStoredBinding(binding: {
  conversation: SessionBindingConversation;
  threadId: string;
  sessionKey: string;
  workspaceDir: string;
  threadTitle?: string;
}): void {
  registerOwnedSessionBinding({
    conversation: binding.conversation,
    threadId: binding.threadId,
    sessionKey: binding.sessionKey,
    metadata: {
      workspaceDir: binding.workspaceDir,
      threadTitle: binding.threadTitle,
    },
  });
}

const discordSdkState = vi.hoisted(() => ({
  buildDiscordComponentMessage: vi.fn((params: { spec: { text?: string; blocks?: unknown[] } }) => ({
    components: [params.spec.text ?? "", ...(params.spec.blocks ?? [])],
    entries: [{ id: "entry-1", kind: "button", label: "Tap" }],
    modals: [],
  })),
  editDiscordComponentMessage: vi.fn(async () => ({
    messageId: "message-1",
    channelId: "channel:chan-1",
  })),
  registerBuiltDiscordComponentMessage: vi.fn(),
  resolveDiscordAccount: vi.fn(() => ({ accountId: "default" })),
}));

const telegramSdkState = vi.hoisted(() => ({
  resolveTelegramAccount: vi.fn(() => ({ accountId: "default", token: "telegram-token" })),
}));

const compatSdkState = vi.hoisted(() => ({
  loadOpenClawCompatModule: vi.fn(async (params: { specifier: string }) => {
    if (params.specifier === "openclaw/plugin-sdk/discord") {
      return {
        buildDiscordComponentMessage: discordSdkState.buildDiscordComponentMessage,
        editDiscordComponentMessage: discordSdkState.editDiscordComponentMessage,
        registerBuiltDiscordComponentMessage: discordSdkState.registerBuiltDiscordComponentMessage,
        resolveDiscordAccount: discordSdkState.resolveDiscordAccount,
      };
    }
    if (params.specifier === "openclaw/plugin-sdk/telegram-account") {
      return {
        resolveTelegramAccount: telegramSdkState.resolveTelegramAccount,
      };
    }
    throw new Error(`Unexpected compat module request: ${params.specifier}`);
  }),
}));

vi.mock("./openclaw-sdk-compat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-sdk-compat.js")>();
  return {
    ...actual,
    loadOpenClawCompatModule: compatSdkState.loadOpenClawCompatModule,
  };
});

function makeStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-app-server-test-"));
}

function createApiMock(options?: { pluginConfig?: Record<string, unknown>; stateDir?: string }) {
  const stateDir = options?.stateDir ?? makeStateDir();
  const sendComponentMessage = vi.fn(async (..._args: unknown[]) => ({ messageId: "discord-component-1", channelId: "channel:chan-1" }));
  const sendMessageDiscord = vi.fn(async (..._args: unknown[]) => ({ messageId: "discord-msg-1", channelId: "channel:chan-1" }));
  const sendMessageTelegram = vi.fn(async (..._args: unknown[]) => ({ messageId: "1", chatId: "123" }));
  const discordTypingStart = vi.fn(async () => ({ refresh: vi.fn(async () => {}), stop: vi.fn() }));
  const renameTopic = vi.fn(async () => ({}));
  const resolveTelegramToken = vi.fn(() => ({ token: "telegram-token", source: "config" }));
  const editChannel = vi.fn(async () => ({}));
  const telegramOutbound = {
    sendText: vi.fn(async (ctx: { to: string; text: string; accountId?: string; threadId?: string | number }) =>
      await sendMessageTelegram(ctx.to, ctx.text, {
        accountId: ctx.accountId,
        messageThreadId: typeof ctx.threadId === "number" ? ctx.threadId : undefined,
      }),
    ),
    sendMedia: vi.fn(
      async (ctx: {
        to: string;
        text: string;
        mediaUrl: string;
        accountId?: string;
        threadId?: string | number;
        mediaLocalRoots?: readonly string[];
      }) =>
        await sendMessageTelegram(ctx.to, ctx.text, {
          accountId: ctx.accountId,
          messageThreadId: typeof ctx.threadId === "number" ? ctx.threadId : undefined,
          mediaUrl: ctx.mediaUrl,
          mediaLocalRoots: ctx.mediaLocalRoots,
        }),
    ),
    sendPayload: vi.fn(
      async (ctx: {
        to: string;
        payload: ReplyPayload;
        accountId?: string;
        threadId?: string | number;
        mediaLocalRoots?: readonly string[];
      }) =>
        await sendMessageTelegram(ctx.to, ctx.payload.text ?? "", {
          accountId: ctx.accountId,
          messageThreadId: typeof ctx.threadId === "number" ? ctx.threadId : undefined,
          mediaUrl: ctx.payload.mediaUrl,
          mediaLocalRoots: ctx.mediaLocalRoots,
          buttons: (ctx.payload.channelData as { telegram?: { buttons?: unknown } } | undefined)
            ?.telegram?.buttons as any,
        }),
    ),
  };
  const discordOutbound = {
    sendText: vi.fn(async (ctx: { to: string; text: string; accountId?: string; threadId?: string | number }) =>
      await sendMessageDiscord(ctx.to, ctx.text, {
        accountId: ctx.accountId,
      }),
    ),
    sendMedia: vi.fn(
      async (ctx: {
        to: string;
        text: string;
        mediaUrl: string;
        accountId?: string;
        threadId?: string | number;
        mediaLocalRoots?: readonly string[];
      }) =>
        await sendMessageDiscord(ctx.to, ctx.text, {
          accountId: ctx.accountId,
          mediaUrl: ctx.mediaUrl,
          mediaLocalRoots: ctx.mediaLocalRoots,
        }),
    ),
    sendPayload: vi.fn(
      async (ctx: {
        to: string;
        payload: ReplyPayload;
        accountId?: string;
        threadId?: string | number;
        mediaLocalRoots?: readonly string[];
      }) =>
        await sendComponentMessage(
          ctx.to,
          ((ctx.payload.channelData as { discord?: { components?: unknown } } | undefined)?.discord
            ?.components as ReplyPayload) ?? { text: ctx.payload.text ?? "" },
          {
            accountId: ctx.accountId,
          },
        ),
    ),
  };
  const api = {
    id: "test-plugin",
    config: {},
    pluginConfig: {
      enabled: true,
      defaultWorkspaceDir: "/repo/openclaw",
      ...(options?.pluginConfig ?? {}),
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    runtime: {
      state: {
        resolveStateDir: () => stateDir,
      },
      channel: {
        bindings: {
          bind: vi.fn(async () => ({})),
          unbind: vi.fn(async () => []),
          resolveByConversation: vi.fn(() => null),
        },
        text: {
          chunkText: (text: string) => [text],
          resolveTextChunkLimit: (_cfg: unknown, _provider?: string, _accountId?: string | null, opts?: { fallbackLimit?: number }) =>
            opts?.fallbackLimit ?? 2000,
        },
        outbound: {
          loadAdapter: vi.fn(async (channel: string) =>
            channel === "telegram"
              ? telegramOutbound
              : channel === "discord"
                ? undefined
                : undefined,
          ),
        },
        telegram: {
          sendMessageTelegram,
          resolveTelegramToken,
          typing: {
            start: vi.fn(async () => ({ refresh: vi.fn(async () => {}), stop: vi.fn() })),
          },
          conversationActions: {
            renameTopic,
          },
        },
        discord: {
          sendMessageDiscord,
          sendComponentMessage,
          typing: {
            start: discordTypingStart,
          },
          conversationActions: {
            editChannel,
          },
        },
      },
    },
    registerService: vi.fn(),
    registerInteractiveHandler: vi.fn(),
    onConversationBindingResolved: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as OpenClawPluginApi;
  return {
    api,
    sendComponentMessage,
    sendMessageDiscord,
    sendMessageTelegram,
    telegramOutbound,
    discordTypingStart,
    renameTopic,
    resolveTelegramToken,
    editChannel,
    discordOutbound,
    stateDir,
  };
}

async function createControllerHarness(options?: {
  pluginConfig?: Record<string, unknown>;
  stateDir?: string;
}) {
  const {
    api,
    sendComponentMessage,
    sendMessageDiscord,
    sendMessageTelegram,
    telegramOutbound,
    discordTypingStart,
    renameTopic,
    resolveTelegramToken,
    editChannel,
    discordOutbound,
    stateDir,
  } = createApiMock(options);
  const controller = new CodexPluginController(api);
  await controller.start();
  const store = (controller as any).store;
  const originalUpsertBinding = store.upsertBinding.bind(store);
  vi.spyOn(store, "upsertBinding").mockImplementation(async (binding: any) => {
    await originalUpsertBinding(binding);
    registerOwnedSessionBindingForStoredBinding(binding);
  });
  const originalRemoveBinding = store.removeBinding.bind(store);
  vi.spyOn(store, "removeBinding").mockImplementation(async (conversation: any) => {
    sessionBindingRecords.delete(toSessionBindingKey(conversation as SessionBindingConversation));
    await originalRemoveBinding(conversation);
  });
  const threadState: any = {
    threadId: "thread-1",
    threadName: "Discord Thread",
    model: "openai/gpt-5.4",
    cwd: "/repo/openclaw",
    serviceTier: "default",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  };
  const clientMock = {
    hasProfile: vi.fn((profile: string) => profile === "default" || profile === "full-access"),
    listThreads: vi.fn(async () => [
      {
        threadId: "thread-1",
        title: "Discord Thread",
        projectKey: "/repo/openclaw",
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      },
    ]),
    startThread: vi.fn(async () => ({
      threadId: "thread-new",
      threadName: "New Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
    })),
    listModels: vi.fn(async () => [
      { id: "openai/gpt-5.4", current: true },
      { id: "openai/gpt-5.3" },
    ]),
    listSkills: vi.fn(async () => [
      { name: "skill-a", description: "Skill A", cwd: "/repo/openclaw" },
      { name: "skill-b", description: "Skill B", cwd: "/repo/openclaw" },
    ]),
    listMcpServers: vi.fn(async () => []),
    readThreadState: vi.fn(async () => ({ ...threadState })),
    readThreadContext: vi.fn(async () => ({
      lastUserMessage: undefined,
      lastAssistantMessage: undefined,
    })),
    setThreadName: vi.fn(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
    })),
    setThreadModel: vi.fn(async (params: { model: string }) => {
      threadState.model = params.model;
      return { ...threadState };
    }),
    setThreadServiceTier: vi.fn(async (params: { serviceTier: string | null }) => {
      threadState.serviceTier = params.serviceTier ?? "default";
      return { ...threadState };
    }),
    setThreadPermissions: vi.fn(async (params: { approvalPolicy: string; sandbox: string }) => {
      threadState.approvalPolicy = params.approvalPolicy;
      threadState.sandbox = params.sandbox;
      return { ...threadState };
    }),
    startReview: vi.fn(() => ({
      result: new Promise(() => {}),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    })),
    readAccount: vi.fn(async () => ({
      email: "test@example.com",
      planType: "pro",
      type: "chatgpt",
    })),
    readRateLimits: vi.fn(async () => []),
  };
  (controller as any).client = clientMock;
  (controller as any).readThreadHasChanges = vi.fn(async () => false);
  return {
    controller,
    api,
    clientMock,
    sendComponentMessage,
    sendMessageDiscord,
    sendMessageTelegram,
    telegramOutbound,
    discordTypingStart,
    renameTopic,
    resolveTelegramToken,
    editChannel,
    discordOutbound,
    stateDir,
  };
}

async function createControllerHarnessWithoutLegacyDiscordRuntime() {
  const harness = createApiMock();
  delete (harness.api as any).runtime.channel.discord;
  (harness.api as any).runtime.channel.outbound.loadAdapter = vi.fn(async (channel: string) =>
    channel === "telegram"
      ? harness.telegramOutbound
      : channel === "discord"
        ? harness.discordOutbound
        : undefined,
  );
  const controller = new CodexPluginController(harness.api);
  await controller.start();
  const clientMock = {
    listThreads: vi.fn(async () => [
      {
        threadId: "thread-1",
        title: "Discord Thread",
        projectKey: "/repo/openclaw",
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      },
    ]),
    readThreadState: vi.fn(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    })),
    readThreadContext: vi.fn(async () => ({
      lastUserMessage: undefined,
      lastAssistantMessage: undefined,
    })),
    readAccount: vi.fn(async () => ({
      email: "test@example.com",
      planType: "pro",
      type: "chatgpt",
    })),
    readRateLimits: vi.fn(async () => []),
  };
  (controller as any).client = clientMock;
  (controller as any).readThreadHasChanges = vi.fn(async () => false);
  return {
    controller,
    discordOutbound: harness.discordOutbound,
  };
}

async function createControllerHarnessWithoutDiscordSendSurfaces() {
  const harness = createApiMock();
  delete (harness.api as any).runtime.channel.discord;
  (harness.api as any).runtime.channel.outbound.loadAdapter = vi.fn(async (channel: string) =>
    channel === "telegram" ? harness.telegramOutbound : undefined,
  );
  const controller = new CodexPluginController(harness.api);
  await controller.start();
  const clientMock = {
    listThreads: vi.fn(async () => [
      {
        threadId: "thread-1",
        title: "Discord Thread",
        projectKey: "/repo/openclaw",
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      },
    ]),
    listSkills: vi.fn(async () => [
      { name: "skill-a", description: "Skill A", cwd: "/repo/openclaw" },
      { name: "skill-b", description: "Skill B", cwd: "/repo/openclaw" },
    ]),
    readThreadState: vi.fn(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    })),
    readThreadContext: vi.fn(async () => ({
      lastUserMessage: undefined,
      lastAssistantMessage: undefined,
    })),
    readAccount: vi.fn(async () => ({
      email: "test@example.com",
      planType: "pro",
      type: "chatgpt",
    })),
    readRateLimits: vi.fn(async () => []),
  };
  (controller as any).client = clientMock;
  (controller as any).readThreadHasChanges = vi.fn(async () => false);
  return {
    controller,
  };
}

async function createControllerHarnessWithoutLegacyBindings() {
  const harness = createApiMock();
  delete (harness.api as any).runtime.channel.bindings;
  const controller = new CodexPluginController(harness.api);
  await controller.start();
  return {
    controller,
    api: harness.api,
  };
}

async function createControllerHarnessWithoutTelegramOutbound() {
  const harness = createApiMock();
  delete (harness.api as any).runtime.channel.outbound;
  const controller = new CodexPluginController(harness.api);
  await controller.start();
  const clientMock = {
    readThreadState: vi.fn(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    })),
    readThreadContext: vi.fn(async () => ({
      lastUserMessage: undefined,
      lastAssistantMessage: undefined,
    })),
    readAccount: vi.fn(async () => ({
      email: "test@example.com",
      planType: "pro",
      type: "chatgpt",
    })),
    readRateLimits: vi.fn(async () => []),
  };
  (controller as any).client = clientMock;
  (controller as any).readThreadHasChanges = vi.fn(async () => false);
  return {
    controller,
    sendMessageTelegram: harness.sendMessageTelegram,
  };
}

async function createControllerHarnessWithoutTelegramPayloadSupport() {
  const harness = createApiMock();
  (harness.api as any).runtime.channel.outbound.loadAdapter = vi.fn(async (channel: string) =>
    channel === "telegram"
      ? {
          sendText: harness.telegramOutbound.sendText,
          sendMedia: harness.telegramOutbound.sendMedia,
        }
      : undefined,
  );
  const controller = new CodexPluginController(harness.api);
  await controller.start();
  const clientMock = {
    readThreadState: vi.fn(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    })),
    readThreadContext: vi.fn(async () => ({
      lastUserMessage: undefined,
      lastAssistantMessage: undefined,
    })),
    readAccount: vi.fn(async () => ({
      email: "test@example.com",
      planType: "pro",
      type: "chatgpt",
    })),
    readRateLimits: vi.fn(async () => []),
  };
  (controller as any).client = clientMock;
  (controller as any).readThreadHasChanges = vi.fn(async () => false);
  return {
    controller,
    api: harness.api,
    sendMessageTelegram: harness.sendMessageTelegram,
  };
}

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
const TEST_PLUGIN_VERSION = packageJson.version ?? "unknown";

type RelaxedCommandContextOverrides = Partial<
  Omit<PluginCommandContext, "requestConversationBinding" | "getCurrentConversationBinding">
> & {
  requestConversationBinding?: (...args: unknown[]) => Promise<unknown>;
  getCurrentConversationBinding?: () => Promise<unknown>;
};

function buildDiscordCommandContext(
  overrides: RelaxedCommandContextOverrides & Record<string, unknown> = {},
): PluginCommandContext {
  return {
    senderId: "user-1",
    channel: "discord",
    channelId: "discord",
    isAuthorizedSender: true,
    args: "",
    commandBody: "/cas_resume",
    config: {},
    from: "discord:channel:chan-1",
    to: "slash:user-1",
    accountId: "default",
    requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
    detachConversationBinding: vi.fn(async () => ({ removed: true })),
    getCurrentConversationBinding: vi.fn(async () => null),
    ...overrides,
  } as unknown as PluginCommandContext;
}

function buildTelegramCommandContext(
  overrides: RelaxedCommandContextOverrides & Record<string, unknown> = {},
): PluginCommandContext {
  return {
    senderId: "user-1",
    channel: "telegram",
    channelId: "telegram",
    isAuthorizedSender: true,
    args: "",
    commandBody: "/cas_status",
    config: {},
    from: "telegram:123",
    to: "telegram:123",
    accountId: "default",
    requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
    detachConversationBinding: vi.fn(async () => ({ removed: true })),
    getCurrentConversationBinding: vi.fn(async () => null),
    ...overrides,
  } as unknown as PluginCommandContext;
}

function extractTelegramCallbackToken(
  reply: ReplyPayload,
  buttonText?: string,
): string {
  const buttons = (reply.channelData as {
    telegram?: { buttons?: Array<Array<{ text: string; callback_data?: string }>> };
  } | undefined)?.telegram?.buttons;
  const button = buttonText
    ? buttons?.flat().find((entry) => entry.text === buttonText || entry.text.includes(buttonText))
    : buttons?.[0]?.[0];
  const callbackData = button?.callback_data;
  expect(callbackData).toMatch(/^codexapp:/);
  return String(callbackData).slice("codexapp:".length);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sessionBindingRecords.clear();
  discordSdkState.buildDiscordComponentMessage.mockClear();
  discordSdkState.editDiscordComponentMessage.mockClear();
  discordSdkState.registerBuiltDiscordComponentMessage.mockClear();
  discordSdkState.resolveDiscordAccount.mockClear();
  telegramSdkState.resolveTelegramAccount.mockClear();
  vi.spyOn(getSessionBindingService(), "resolveByConversation").mockImplementation(
    (conversation) =>
      sessionBindingRecords.get(
        toSessionBindingKey(conversation as SessionBindingConversation),
      ) as any,
  );
  vi.spyOn(CodexAppServerClient.prototype, "logStartupProbe").mockResolvedValue();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
    })),
  );
});

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Discord controller flows", () => {
  it("falls back to the Discord runtime api when the sdk edit helper is missing", async () => {
    const { controller } = await createControllerHarness();
    const runtimeEdit = vi.fn(async () => ({
      messageId: "message-1",
      channelId: "channel:chan-1",
    }));
    const originalEdit = discordSdkState.editDiscordComponentMessage;
    (discordSdkState as { editDiscordComponentMessage?: unknown }).editDiscordComponentMessage =
      undefined;
    vi.spyOn(controller as any, "loadDiscordRuntimeApi").mockResolvedValue({
      editDiscordComponentMessage: runtimeEdit,
    });

    try {
      const result = await (controller as any).editDiscordComponentMessage(
        "channel:chan-1",
        "message-1",
        { text: "Hello from runtime api." },
        { accountId: "default" },
      );

      expect(result).toEqual({
        messageId: "message-1",
        channelId: "channel:chan-1",
      });
      expect(runtimeEdit).toHaveBeenCalledWith(
        "channel:chan-1",
        "message-1",
        { text: "Hello from runtime api." },
        expect.objectContaining({
          accountId: "default",
          cfg: expect.any(Object),
        }),
      );
    } finally {
      discordSdkState.editDiscordComponentMessage = originalEdit;
    }
  });

  it("falls back to the Discord runtime api when the sdk register helper is missing", async () => {
    const { controller } = await createControllerHarness();
    const runtimeRegister = vi.fn();
    const originalRegister = discordSdkState.registerBuiltDiscordComponentMessage;
    (
      discordSdkState as { registerBuiltDiscordComponentMessage?: unknown }
    ).registerBuiltDiscordComponentMessage = undefined;
    vi.spyOn(controller as any, "loadDiscordRuntimeApi").mockResolvedValue({
      registerBuiltDiscordComponentMessage: runtimeRegister,
    });
    const buildResult = {
      components: ["hello"],
      entries: [{ id: "entry-1", kind: "button", label: "Tap" }],
      modals: [],
    };

    try {
      await (controller as any).registerBuiltDiscordComponentMessage({
        buildResult,
        messageId: "message-1",
      });

      expect(runtimeRegister).toHaveBeenCalledWith({
        buildResult,
        messageId: "message-1",
      });
    } finally {
      discordSdkState.registerBuiltDiscordComponentMessage = originalRegister;
    }
  });

  it("starts cleanly without the legacy runtime.channel.bindings surface", async () => {
    const { controller } = await createControllerHarnessWithoutLegacyBindings();

    expect(controller).toBeInstanceOf(CodexPluginController);
  });

  it("stops the shared app-server client and interrupts active runs on service stop", async () => {
    const { controller } = await createControllerHarness();
    const interrupt = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    (controller as any).client.close = close;
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", aborted: true }),
        queueMessage: vi.fn(async () => false),
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
        interrupt,
        isAwaitingInput: vi.fn(() => false),
        getThreadId: vi.fn(() => "thread-1"),
      },
    });

    await controller.stop();

    expect(interrupt).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect((controller as any).activeRuns.size).toBe(0);
  });

  it("uses the real Discord conversation target for slash-command resume pickers", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();

    const reply = await controller.handleCommand("cas_resume", buildDiscordCommandContext());

    expect(reply).toEqual({
      text: "Sent a Codex thread picker to this Discord conversation.",
    });
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Showing recent Codex threads"),
      }),
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("sends resume pickers through the Discord outbound adapter when the legacy runtime is absent", async () => {
    const { controller, discordOutbound } = await createControllerHarnessWithoutLegacyDiscordRuntime();

    const reply = await controller.handleCommand("cas_resume", buildDiscordCommandContext());

    expect(reply).toEqual({
      text: "Sent a Codex thread picker to this Discord conversation.",
    });
    expect(discordOutbound.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "channel:chan-1",
        accountId: "default",
        payload: expect.objectContaining({
          text: expect.stringContaining("Showing recent Codex threads"),
          channelData: expect.objectContaining({
            discord: expect.objectContaining({
              components: expect.objectContaining({
                blocks: expect.any(Array),
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("sends resume pickers through the Discord runtime api when adapter and legacy runtime are absent", async () => {
    const { controller } = await createControllerHarnessWithoutDiscordSendSurfaces();
    const sendDiscordComponentMessage = vi.fn(async () => ({
      messageId: "discord-component-1",
      channelId: "channel:chan-1",
    }));
    vi.spyOn(controller as any, "loadDiscordRuntimeApi").mockResolvedValue({
      sendDiscordComponentMessage,
    });

    const reply = await controller.handleCommand("cas_resume", buildDiscordCommandContext());

    expect(reply).toEqual({
      text: "Sent a Codex thread picker to this Discord conversation.",
    });
    expect(sendDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Showing recent Codex threads"),
        blocks: expect.any(Array),
      }),
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("renders structured help text for representative commands via handleCommand", async () => {
    const { controller } = await createControllerHarness();

    const fastHelp = await controller.handleCommand("cas_fast", buildDiscordCommandContext({
      args: "help",
      commandBody: "/cas_fast help",
    }));
    const resumeHelp = await controller.handleCommand("cas_resume", buildDiscordCommandContext({
      args: "--help",
      commandBody: "/cas_resume --help",
    }));
    const renameHelp = await controller.handleCommand("cas_rename", buildDiscordCommandContext({
      args: "help",
      commandBody: "/cas_rename help",
    }));

    expect(fastHelp.text).toContain("/cas_fast");
    expect(fastHelp.text).toContain("Usage:");
    expect(fastHelp.text).toContain("Examples:");
    expect(resumeHelp.text).toContain("/cas_resume");
    expect(resumeHelp.text).toContain("Flags/Args:");
    expect(renameHelp.text).toContain("/cas_rename");
    expect(renameHelp.text).toContain("Usage:");
  });

  it("renders help when Telegram-style em dash is used for --help", async () => {
    const { controller } = await createControllerHarness();

    const resumeHelp = await controller.handleCommand("cas_resume", buildDiscordCommandContext({
      args: "—help",
      commandBody: "/cas_resume —help",
    }));
    const statusHelp = await controller.handleCommand("cas_status", buildDiscordCommandContext({
      args: "—help",
      commandBody: "/cas_status —help",
    }));

    expect(resumeHelp.text).toContain("/cas_resume");
    expect(resumeHelp.text).toContain("Usage:");
    expect(statusHelp.text).toContain("/cas_status");
    expect(statusHelp.text).toContain("--yolo, --no-yolo");
  });

  it("keeps usage error paths for cas_fast, cas_steer, and cas_plan", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const fastUsage = await controller.handleCommand("cas_fast", buildDiscordCommandContext({
      args: "nope",
      commandBody: "/cas_fast nope",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));
    const steerUsage = await controller.handleCommand("cas_steer", buildDiscordCommandContext({
      args: "",
      commandBody: "/cas_steer",
    }));
    const planUsage = await controller.handleCommand("cas_plan", buildDiscordCommandContext({
      args: "",
      commandBody: "/cas_plan",
    }));

    expect(fastUsage).toEqual({ text: "Usage: /cas_fast [on|off|status]" });
    expect(steerUsage).toEqual({ text: "Usage: /cas_steer <message>" });
    expect(planUsage).toEqual({ text: "Usage: /cas_plan <goal> | /cas_plan off" });
  });

  it("still lets cas_steer send an explicit steer message to the active run", async () => {
    const { controller } = await createControllerHarness();
    const queueMessage = vi.fn(async () => true);
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "stale" }),
        queueMessage,
        getThreadId: () => "thread-1",
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });

    const reply = await controller.handleCommand("cas_steer", buildDiscordCommandContext({
      args: "please shorten it",
      commandBody: "/cas_steer please shorten it",
    }));

    expect(queueMessage).toHaveBeenCalledWith("please shorten it");
    expect(reply).toEqual({ text: "Sent steer message to Codex." });
  });

  it("offers a New button on /cas_resume and flips into the new-thread project picker", async () => {
    const { controller } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        commandBody: "/cas_resume",
      }),
    );

    const buttons = (reply.channelData as any)?.telegram?.buttons;
    expect(buttons?.flat().some((button: { text: string }) => button.text === "Projects")).toBe(true);
    expect(buttons?.flat().some((button: { text: string }) => button.text === "Browse Projects")).toBe(false);
    const newButton = buttons?.flat().find((button: { text: string }) => button.text === "New");
    expect(newButton?.callback_data).toBeTruthy();
    const token = (newButton?.callback_data as string).split(":").pop() ?? "";
    const callback = (controller as any).store.getCallback(token);
    expect(callback).toEqual(expect.objectContaining({
      kind: "picker-view",
      view: expect.objectContaining({
        mode: "projects",
        action: "start-new-thread",
      }),
    }));

    const editMessage = vi.fn(async (_payload: any) => {});
    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      callback: {
        payload: token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(editMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Choose a project for the new Codex thread"),
      buttons: expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("openclaw"),
          }),
        ]),
        expect.arrayContaining([
          expect.objectContaining({
            text: "Recent Threads",
          }),
        ]),
      ]),
    }));
  });

  it("shows a project picker for /cas_resume --new without args", async () => {
    const { controller } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--new",
        commandBody: "/cas_resume --new",
      }),
    );

    expect(reply.text).toContain("Choose a project for the new Codex thread");
    const buttons = (reply.channelData as any)?.telegram?.buttons;
    expect(buttons?.[0]?.[0]?.text).toContain("openclaw");
    expect(buttons?.flat().some((button: { text: string }) => button.text === "Recent Threads")).toBe(true);
    const callbackData = buttons?.[0]?.[0]?.callback_data as string;
    const token = callbackData.split(":").pop() ?? "";
    const callback = (controller as any).store.getCallback(token);
    expect(callback?.kind).toBe("start-new-thread");
  });

  it("collapses matching worktrees to one project root in the /cas_resume --new picker", async () => {
    const { controller } = await createControllerHarness();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-worktree-picker-"));
    const canonicalWorkspaceDir = path.join(tempRoot, "github", "openclaw");
    const worktreeA = path.join(tempRoot, ".codex", "worktrees", "7d9d", "openclaw");
    const worktreeB = path.join(tempRoot, ".codex", "worktrees", "1999", "openclaw");
    fs.mkdirSync(canonicalWorkspaceDir, { recursive: true });
    fs.mkdirSync(worktreeA, { recursive: true });
    fs.mkdirSync(worktreeB, { recursive: true });

    (controller as any).client.listThreads.mockResolvedValue([
      {
        threadId: "thread-a",
        title: "Feature A",
        projectKey: worktreeA,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      },
      {
        threadId: "thread-b",
        title: "Feature B",
        projectKey: worktreeB,
        createdAt: Date.now() - 50_000,
        updatedAt: Date.now() - 20_000,
      },
    ]);
    (controller as any).resolveProjectFolder = vi.fn(async (workspaceDir?: string) => {
      if (!workspaceDir?.includes("/.codex/worktrees/")) {
        return workspaceDir;
      }
      return canonicalWorkspaceDir;
    });

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--new",
        commandBody: "/cas_resume --new",
      }),
    );

    expect(reply.text).toContain("Choose a project for the new Codex thread");
    const buttons = (reply.channelData as any)?.telegram?.buttons;
    expect(buttons?.[0]?.[0]?.text).toBe("openclaw (2)");
    const callbackData = buttons?.[0]?.[0]?.callback_data as string;
    const token = callbackData.split(":").pop() ?? "";
    expect((controller as any).store.getCallback(token)).toEqual(expect.objectContaining({
      kind: "start-new-thread",
      workspaceDir: canonicalWorkspaceDir,
    }));
  });

  it("ignores removed worktree history when the project root still exists in the /cas_resume --new picker", async () => {
    const { controller } = await createControllerHarness();
    const canonicalWorkspaceParent = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-root-"));
    const canonicalWorkspaceDir = path.join(canonicalWorkspaceParent, "openclaw");
    fs.mkdirSync(canonicalWorkspaceDir);

    (controller as any).client.listThreads.mockResolvedValue([
      {
        threadId: "thread-root",
        title: "Main Root",
        projectKey: canonicalWorkspaceDir,
        createdAt: Date.now() - 70_000,
        updatedAt: Date.now() - 10_000,
      },
      {
        threadId: "thread-stale-a",
        title: "Removed Worktree A",
        projectKey: path.join(canonicalWorkspaceParent, "worktrees/fd73/openclaw"),
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      },
      {
        threadId: "thread-stale-b",
        title: "Removed Worktree B",
        projectKey: path.join(canonicalWorkspaceParent, "worktrees/80de/openclaw"),
        createdAt: Date.now() - 50_000,
        updatedAt: Date.now() - 20_000,
      },
    ]);

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--new",
        commandBody: "/cas_resume --new",
      }),
    );

    expect(reply.text).toContain("Choose a project for the new Codex thread");
    const buttons = (reply.channelData as any)?.telegram?.buttons;
    expect(buttons?.[0]?.[0]?.text).toBe("openclaw (3)");
    const callbackData = buttons?.[0]?.[0]?.callback_data as string;
    const token = callbackData.split(":").pop() ?? "";
    expect((controller as any).store.getCallback(token)).toEqual(expect.objectContaining({
      kind: "start-new-thread",
      workspaceDir: canonicalWorkspaceDir,
    }));
  });

  it("starts a new thread directly for /cas_resume --new <project>", async () => {
    const { controller, clientMock } = await createControllerHarness();
    const requestConversationBinding = vi.fn(async () => ({ status: "bound" as const }));

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--new openclaw",
        commandBody: "/cas_resume --new openclaw",
        requestConversationBinding,
      }),
    );

    expect(reply).toEqual({});
    expect(clientMock.startThread).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: undefined,
      workspaceDir: "/repo/openclaw",
      model: undefined,
    });
    expect(requestConversationBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("Bind this conversation to Codex thread"),
      }),
    );
  });

  it("keeps grouped project names in the /cas_resume --new picker and disambiguates after selection", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.listThreads.mockResolvedValue([
      {
        threadId: "thread-a",
        title: "Customer A",
        projectKey: "/work/customer-a/app",
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      },
      {
        threadId: "thread-b",
        title: "Customer B",
        projectKey: "/work/customer-b/app",
        createdAt: Date.now() - 50_000,
        updatedAt: Date.now() - 20_000,
      },
    ]);

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--new app",
        commandBody: "/cas_resume --new app",
      }),
    );

    expect(clientMock.startThread).not.toHaveBeenCalled();
    const buttons = (reply.channelData as any)?.telegram?.buttons;
    expect(buttons?.[0]?.[0]?.text).toBe("app (2)");
    const token = (buttons?.[0]?.[0]?.callback_data as string).split(":").pop() ?? "";
    expect((controller as any).store.getCallback(token)).toEqual(expect.objectContaining({
      kind: "picker-view",
      view: expect.objectContaining({
        mode: "workspaces",
        projectName: "app",
      }),
    }));

    const editMessage = vi.fn(async (_payload: any) => {});
    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      callback: {
        payload: token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(editMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Multiple workspaces matched app"),
      buttons: expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("/work/customer-b/app"),
          }),
        ]),
        expect.arrayContaining([
          expect.objectContaining({
            text: "Projects",
          }),
          expect.objectContaining({
            text: "Recent Threads",
          }),
        ]),
      ]),
    }));
  });

  it("expands home-relative paths for /cas_resume --new positional workspace args", async () => {
    const { controller, clientMock } = await createControllerHarness();
    const requestConversationBinding = vi.fn(async () => ({ status: "bound" as const }));

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--new ~/github/openclaw",
        commandBody: "/cas_resume --new ~/github/openclaw",
        requestConversationBinding,
      }),
    );

    expect(reply).toEqual({});
    expect(clientMock.startThread).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: undefined,
      workspaceDir: path.join(os.homedir(), "github/openclaw"),
      model: undefined,
    });
  });

  it("rejects resume when the thread worktree path no longer exists on disk", async () => {
    const { controller, clientMock } = await createControllerHarness();
    const missingWorktreePath = "/tmp/worktrees/bold-bartik/repo-name";
    clientMock.listThreads.mockResolvedValue([
      {
        threadId: "thread-stale",
        title: "Stale Worktree Thread",
        projectKey: missingWorktreePath,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      },
    ]);
    clientMock.readThreadState.mockResolvedValue({
      threadId: "thread-stale",
      threadName: "Stale Worktree Thread",
      model: "openai/gpt-5.4",
      cwd: missingWorktreePath,
      serviceTier: "default",
    });

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "thread-stale",
        commandBody: "/cas_resume thread-stale",
      }),
    );

    const token = extractTelegramCallbackToken(reply, "Stale Worktree Thread");
    const interactiveReply = vi.fn(async () => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: token },
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: interactiveReply,
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(interactiveReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Cannot resume"),
      }),
    );
    expect(interactiveReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(missingWorktreePath),
      }),
    );
    expect(interactiveReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("no longer exists on disk"),
      }),
    );
  });

  it("shows a picker instead of binding immediately for a single matched /cas_resume query", async () => {
    const { controller } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "thread-1",
        commandBody: "/cas_resume thread-1",
      }),
    );

    expect(reply.text).toContain("Showing recent Codex threads");
    expect(reply.text).toContain("Tap a thread to resume it.");
    expect(extractTelegramCallbackToken(reply, "Discord Thread")).toBeTruthy();
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding).toBeNull();
  });

  it("applies model, fast, and yolo flags when resuming a thread after picker selection", async () => {
    const { controller } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "thread-1 --model gpt-5.4 --fast --yolo",
        commandBody: "/cas_resume thread-1 --model gpt-5.4 --fast --yolo",
      }),
    );

    const token = extractTelegramCallbackToken(reply, "Discord Thread");

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: token },
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(binding?.preferences?.preferredModel).toBe("gpt-5.4");
    expect(binding?.preferences?.preferredServiceTier).toBe("fast");
  });

  it("applies em-dash model, fast, and yolo flags when resuming a thread after picker selection", async () => {
    const { controller } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "thread-1 —model gpt-5.4 —fast —yolo",
        commandBody: "/cas_resume thread-1 —model gpt-5.4 —fast —yolo",
      }),
    );

    const token = extractTelegramCallbackToken(reply, "Discord Thread");

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: token },
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(binding?.preferences?.preferredModel).toBe("gpt-5.4");
    expect(binding?.preferences?.preferredServiceTier).toBe("fast");
  });

  it("preserves em-dash resume overrides through the no-query picker callback", async () => {
    const { controller } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "—model gpt-5.3-codex-spark —yolo",
        commandBody: "/cas_resume —model gpt-5.3-codex-spark —yolo",
      }),
    );

    const buttons = (reply.channelData as any)?.telegram?.buttons;
    const callbackData = buttons?.[0]?.[0]?.callback_data as string | undefined;
    expect(callbackData).toMatch(/^codexapp:/);

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callbackData?.slice("codexapp:".length) },
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(binding?.preferences?.preferredModel).toBe("gpt-5.3-codex-spark");
  });

  it("resolves channel identity from ctx.to when ctx.from is a slash identity in a new Discord thread", async () => {
    // Regression test for brand-new Discord threads where the slash interaction
    // places the slash user identity in ctx.from and the channel target in ctx.to.
    const { controller, sendComponentMessage } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildDiscordCommandContext({
        from: "slash:user-1",
        to: "discord:channel:chan-1",
      }),
    );

    expect(reply).toEqual({
      text: "Sent a Codex thread picker to this Discord conversation.",
    });
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Showing recent Codex threads"),
      }),
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("sends Discord skills directly instead of returning Telegram buttons", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();

    const reply = await controller.handleCommand("cas_skills", buildDiscordCommandContext({
      commandBody: "/cas_skills",
    }));

    expect(reply).toEqual({
      text: "Sent Codex skills to this Discord conversation.",
    });
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Type `$skill-name` in this chat to run one directly."),
        blocks: expect.arrayContaining([
          expect.objectContaining({
            buttons: expect.arrayContaining([
              expect.objectContaining({ label: "$skill-a" }),
              expect.objectContaining({ label: "$skill-b" }),
            ]),
          }),
          expect.objectContaining({
            buttons: expect.arrayContaining([
              expect.objectContaining({ label: "Mode: toggle" }),
              expect.objectContaining({ label: "Cancel" }),
            ]),
          }),
        ]),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("sends Discord skills through the runtime api when adapter and legacy runtime are absent", async () => {
    const { controller } = await createControllerHarnessWithoutDiscordSendSurfaces();
    const sendDiscordComponentMessage = vi.fn(async () => ({
      messageId: "discord-component-1",
      channelId: "channel:chan-1",
    }));
    vi.spyOn(controller as any, "loadDiscordRuntimeApi").mockResolvedValue({
      sendDiscordComponentMessage,
    });

    const reply = await controller.handleCommand("cas_skills", buildDiscordCommandContext({
      commandBody: "/cas_skills",
    }));

    expect(reply).toEqual({
      text: "Sent Codex skills to this Discord conversation.",
    });
    expect(sendDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Type `$skill-name` in this chat to run one directly."),
        blocks: expect.any(Array),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("resolves the Discord bot token through the host api when the sdk facade is unavailable", async () => {
    const { controller } = await createControllerHarness();
    (controller as any).lastRuntimeConfig = { plugins: { discord: {} } };
    vi.spyOn(controller as any, "loadDiscordSdk").mockRejectedValue(
      new Error(
        "Cannot find module '/Users/huntharo/github/openclaw/dist/plugin-sdk/root-alias.cjs/discord'",
      ),
    );
    const resolveDiscordAccount = vi.fn(() => ({ token: "discord-token" }));
    vi.spyOn(controller as any, "loadDiscordExtensionApi").mockResolvedValue({
      resolveDiscordAccount,
    });

    const token = await (controller as any).resolveDiscordBotToken("default");

    expect(token).toBe("discord-token");
    expect(resolveDiscordAccount).toHaveBeenCalledWith({
      cfg: { plugins: { discord: {} } },
      accountId: "default",
    });
  });

  it("deduplicates skills with the same name in the skills picker", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.listSkills.mockResolvedValueOnce([
      { name: "last30days", description: "Variant A", cwd: "/repo/openclaw" },
      { name: "last30days", description: "Variant B", cwd: "/repo/openclaw" },
      { name: "agent-browser", description: "Browser", cwd: "/repo/openclaw" },
    ]);

    const picker = await (controller as any).buildSkillsPicker(
      {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      null,
      {
        page: 0,
        clickMode: "run",
      },
    );

    const labels = (picker.buttons as Array<Array<{ text: string }>> | undefined)
      ?.flat()
      .map((button) => button.text) ?? [];
    expect(labels.filter((label) => label === "$last30days")).toHaveLength(1);
    expect(labels).toEqual(expect.arrayContaining(["$last30days", "$agent-browser"]));
  });

  it("refreshes Discord pickers by editing the original interaction message", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "picker-view",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      view: {
        mode: "threads",
        includeAll: true,
        page: 0,
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage,
        clearComponents: vi.fn(async () => {}),
      },
    } as any);

    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        components: expect.any(Array),
      }),
    );
    expect(discordSdkState.registerBuiltDiscordComponentMessage).toHaveBeenCalledWith({
      buildResult: expect.objectContaining({
        components: expect.any(Array),
        entries: expect.any(Array),
      }),
      messageId: "message-1",
    });
    expect(discordSdkState.editDiscordComponentMessage).not.toHaveBeenCalled();
    expect(sendComponentMessage).not.toHaveBeenCalled();
  });

  it("refreshes the Discord project picker by editing the interaction message", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "picker-view",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      view: {
        mode: "projects",
        includeAll: true,
        page: 0,
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage,
        clearComponents: vi.fn(async () => {}),
      },
    } as any);

    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        components: expect.any(Array),
      }),
    );
    expect(discordSdkState.registerBuiltDiscordComponentMessage).toHaveBeenCalledWith({
      buildResult: expect.objectContaining({
        components: expect.any(Array),
        entries: expect.any(Array),
      }),
      messageId: "message-1",
    });
    expect(discordSdkState.editDiscordComponentMessage).not.toHaveBeenCalled();
    expect(sendComponentMessage).not.toHaveBeenCalled();
  });

  it("falls back to direct Discord message edit when the interaction was already acknowledged", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "picker-view",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      view: {
        mode: "projects",
        includeAll: true,
        page: 0,
      },
    });
    const acknowledge = vi.fn(async () => {});
    const editMessage = vi.fn(async () => {
      throw new Error("Interaction has already been acknowledged.");
    });

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge,
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage,
        clearComponents: vi.fn(async () => {}),
      },
    } as any);

    expect(editMessage).toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(discordSdkState.registerBuiltDiscordComponentMessage).not.toHaveBeenCalled();
    expect(discordSdkState.editDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      "message-1",
      expect.objectContaining({
        text: expect.stringContaining("Choose a project to filter recent Codex threads"),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
    expect(sendComponentMessage).not.toHaveBeenCalled();
  });

  it("acknowledges and clears Discord pending-input buttons by message id", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertPendingRequest({
      requestId: "pending-1",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      state: {
        requestId: "pending-1",
        options: ["Approve Once", "Cancel"],
        expiresAt: Date.now() + 60_000,
      },
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "pending-input",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      requestId: "pending-1",
      actionIndex: 0,
    });
    const acknowledge = vi.fn(async () => {});
    const clearComponents = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const followUp = vi.fn(async () => {});
    const submitPendingInput = vi.fn(async () => true);
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "done" }),
        queueMessage: vi.fn(async () => false),
        submitPendingInput,
        submitPendingInputPayload: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: vi.fn(() => true),
        getThreadId: vi.fn(() => "thread-1"),
      },
    });

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge,
        reply,
        followUp,
        editMessage: vi.fn(async () => {}),
        clearComponents,
      },
    } as any);

    expect(submitPendingInput).toHaveBeenCalledWith(0);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(clearComponents).not.toHaveBeenCalled();
    expect(discordSdkState.editDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      "message-1",
      {
        text: "Sent to Codex.",
      },
      expect.objectContaining({ accountId: "default" }),
    );
    expect(reply).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
  });

  it("does not send a second Discord response after completing a questionnaire", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertPendingRequest({
      requestId: "questionnaire-1",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      state: {
        requestId: "questionnaire-1",
        options: [],
        expiresAt: Date.now() + 60_000,
        questionnaire: {
          currentIndex: 1,
          awaitingFreeform: false,
          questions: [
            {
              index: 0,
              id: "milk",
              header: "Milk",
              prompt: "Do you like milk on cereal?",
              options: [
                { key: "A", label: "Yes", description: "Sure." },
                { key: "B", label: "No", description: "Nope." },
              ],
            },
            {
              index: 1,
              id: "type",
              header: "Type",
              prompt: "What kind of milk?",
              options: [
                { key: "A", label: "Whole", description: "Richer." },
                { key: "B", label: "2%", description: "Lighter." },
              ],
            },
          ],
          answers: [
            {
              kind: "option",
              optionKey: "A",
              optionLabel: "Yes",
            },
            null,
          ],
        },
      },
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "pending-questionnaire",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      requestId: "questionnaire-1",
      questionIndex: 1,
      action: "select",
      optionIndex: 0,
    });
    const acknowledge = vi.fn(async () => {});
    const clearComponents = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const followUp = vi.fn(async () => {});
    const submitPendingInputPayload = vi.fn(async () => true);
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "plan",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "done" }),
        queueMessage: vi.fn(async () => false),
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload,
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: vi.fn(() => true),
        getThreadId: vi.fn(() => "thread-1"),
      },
    });

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge,
        reply,
        followUp,
        editMessage: vi.fn(async () => {}),
        clearComponents,
      },
    } as any);

    expect(submitPendingInputPayload).toHaveBeenCalledWith({
      answers: {
        milk: { answers: ["Yes"] },
        type: { answers: ["Whole"] },
      },
    });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(clearComponents).not.toHaveBeenCalled();
    expect(discordSdkState.editDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      "message-1",
      {
        text: "Recorded your answers and sent them to Codex.",
      },
      expect.objectContaining({ accountId: "default" }),
    );
    expect(reply).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
  });

  it("annotates delayed questionnaire replies so Codex can distinguish them from defaults", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:31:00-04:00"));
    try {
      const { controller } = await createControllerHarness();
      const createdAt = Date.now() - 52 * 60_000;
      await (controller as any).store.upsertPendingRequest({
        requestId: "questionnaire-2",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        state: {
          requestId: "questionnaire-2",
          options: [],
          expiresAt: Date.now() + 7 * 24 * 60 * 60_000,
          questionnaire: {
            currentIndex: 1,
            awaitingFreeform: false,
            questions: [
              {
                index: 0,
                id: "milk",
                header: "Milk",
                prompt: "Do you like milk on cereal?",
                options: [
                  { key: "A", label: "Cereal (Recommended)", description: "Default-looking choice." },
                  { key: "B", label: "Bagels", description: "Alternate choice." },
                ],
                guidance: [],
              },
              {
                index: 1,
                id: "type",
                header: "Type",
                prompt: "What kind of milk?",
                options: [
                  { key: "A", label: "Whole", description: "Richer." },
                  { key: "B", label: "2%", description: "Lighter." },
                ],
                guidance: [],
              },
            ],
            answers: [
              {
                kind: "option",
                optionKey: "A",
                optionLabel: "Cereal (Recommended)",
              },
              null,
            ],
            responseMode: "structured",
          },
        },
        createdAt,
        updatedAt: createdAt,
      });
      const callback = await (controller as any).store.putCallback({
        kind: "pending-questionnaire",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        requestId: "questionnaire-2",
        questionIndex: 1,
        action: "select",
        optionIndex: 0,
      });
      const acknowledge = vi.fn(async () => {});
      const clearComponents = vi.fn(async () => {});
      const reply = vi.fn(async () => {});
      const followUp = vi.fn(async () => {});
      const submitPendingInputPayload = vi.fn(async () => true);
      (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        workspaceDir: "/repo/openclaw",
        mode: "plan",
        handle: {
          result: Promise.resolve({ threadId: "thread-1", text: "done" }),
          queueMessage: vi.fn(async () => false),
          submitPendingInput: vi.fn(async () => false),
          submitPendingInputPayload,
          interrupt: vi.fn(async () => {}),
          isAwaitingInput: vi.fn(() => true),
          getThreadId: vi.fn(() => "thread-1"),
        },
      });

      await controller.handleDiscordInteractive({
        channel: "discord",
        accountId: "default",
        interactionId: "interaction-2",
        conversationId: "channel:chan-1",
        auth: { isAuthorizedSender: true },
        interaction: {
          kind: "button",
          data: `codexapp:${callback.token}`,
          namespace: "codexapp",
          payload: callback.token,
          messageId: "message-2",
        },
        senderId: "user-1",
        senderUsername: "Ada",
        respond: {
          acknowledge,
          reply,
          followUp,
          editMessage: vi.fn(async () => {}),
          clearComponents,
        },
      } as any);

      expect(submitPendingInputPayload).toHaveBeenCalledWith({
        answers: {
          milk: {
            answers: [
              "Cereal (Recommended)",
              "user_note: This answer was selected by the user in chat after 52 minutes; it was not auto-selected.",
            ],
          },
          type: { answers: ["Whole"] },
        },
      });
      expect(acknowledge).toHaveBeenCalledTimes(1);
      expect(clearComponents).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
      expect(followUp).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes raw Discord callback conversation ids for guild interactions", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "picker-view",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      view: {
        mode: "projects",
        includeAll: true,
        page: 0,
      },
    });

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "1481858418548412579",
      guildId: "guild-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
        clearComponents: vi.fn(async () => {
          throw new Error("Interaction has already been acknowledged.");
        }),
      },
    } as any);

    expect(sendComponentMessage).not.toHaveBeenCalled();
  });

  it("hydrates a pending approved binding when status is requested after core approval", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand("cas_status", buildDiscordCommandContext({
      commandBody: "/cas_status",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));

    expect(reply).toEqual({
      text: "Sent Codex status controls to this Discord conversation.",
    });
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Binding: Discord Thread (openclaw)"),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
    expect((controller as any).store.getBinding({
      channel: "discord",
      accountId: "default",
      conversationId: "channel:chan-1",
    })).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
      }),
    );
  });

  it("shows cas_status as none when no core binding exists", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1177378744822943744",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/discrawl",
      threadTitle: "Summarize tools used",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildDiscordCommandContext({
        from: "discord:1177378744822943744",
        to: "slash:1177378744822943744",
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => null),
      }),
    );

    expect(reply.text).toContain("Binding: none");
    expect(reply.text).toContain(`Plugin version: ${TEST_PLUGIN_VERSION}`);
    expect(reply.text).not.toContain("Project folder: /repo/discrawl");
    expect(reply.text).not.toContain("Session: session-1");
  });

  it("does not hydrate a denied pending bind into cas_status", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/discrawl",
      threadTitle: "Summarize tools used",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => null),
      }),
    );

    expect(reply.text).toContain("Binding: none");
    expect(reply.text).not.toContain("Project folder: /repo/discrawl");
    expect((controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    })).toBeNull();
  });

  it("shows plan mode on in cas_status when the bound conversation has an active plan run", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      updatedAt: Date.now(),
    });
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "plan",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "planned" }),
        queueMessage: vi.fn(async () => true),
        getThreadId: () => "thread-1",
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });

    const reply = await controller.handleCommand("cas_status", buildDiscordCommandContext({
      commandBody: "/cas_status",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));

    expect(reply).toEqual({
      text: "Sent Codex status controls to this Discord conversation.",
    });
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Binding: Discord Thread (openclaw)"),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Plan mode: on"),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("shows fast mode off when defaultServiceTier is configured to default", async () => {
    const { controller, sendMessageTelegram, clientMock } = await createControllerHarness({
      pluginConfig: { defaultServiceTier: "default" },
    });
    clientMock.readThreadState.mockResolvedValue({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "fast",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    expect(reply).toEqual({});
    const firstCall = sendMessageTelegram.mock.calls[0] as unknown as [string, string] | undefined;
    expect(firstCall?.[1]).toContain("Fast mode: off");
  });

  it("sends and pins status control buttons when a binding exists", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    const fetchMock = vi.mocked(fetch);
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    expect(reply).toEqual({});
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    const firstCall = sendMessageTelegram.mock.calls[0] as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string; callback_data: string }>> }]
      | undefined;
    const buttons = firstCall?.[2]?.buttons ?? [];

    expect(buttons).toHaveLength(5);
    expect(buttons[0][0].text).toBe("Select Model");
    expect(buttons[0][1].text).toBe("Reasoning: Default");
    expect(buttons[1][0].text).toBe("Fast: toggle");
    expect(buttons[1][1].text).toBe("Permissions: toggle");
    expect(buttons[2][0].text).toBe("Compact");
    expect(buttons[2][1].text).toBe("Stop");
    expect(buttons[3][0].text).toBe("Refresh");
    expect(buttons[3][1].text).toBe("Detach");
    expect(buttons[4][0].text).toBe("Skills");
    expect(buttons[4][1].text).toBe("MCPs");
    const kinds = buttons.flatMap((row: Array<{ callback_data: string }>) => {
      return row.map((button) => {
        const token = button.callback_data.split(":").pop() ?? "";
        return (controller as any).store.getCallback(token)?.kind;
      });
    });
    expect(kinds).toEqual(
      expect.arrayContaining([
        "show-model-picker",
        "show-reasoning-picker",
        "toggle-fast",
        "toggle-permissions",
        "compact-thread",
        "stop-run",
        "refresh-status",
        "detach-thread",
        "show-skills",
        "show-mcp",
      ]),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the legacy Telegram runtime when outbound adapters are unavailable", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarnessWithoutTelegramOutbound();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    expect(reply).toEqual({});
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Binding: Discord Thread"),
      expect.objectContaining({
        accountId: "default",
        buttons: expect.any(Array),
      }),
    );
  });

  it("uses the Telegram runtime API helper when outbound and legacy Telegram send surfaces are unavailable", async () => {
    const { controller } = await createControllerHarnessWithoutTelegramOutbound();
    const runtimeSendMessageTelegram = vi.fn(async () => ({ messageId: "rt-1", chatId: "123" }));
    delete ((controller as any).api.runtime.channel as any).telegram;
    vi.spyOn(controller as any, "loadTelegramRuntimeApi").mockResolvedValue({
      sendMessageTelegram: runtimeSendMessageTelegram,
    });
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    expect(reply).toEqual({});
    expect(runtimeSendMessageTelegram).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Binding: Discord Thread"),
      expect.objectContaining({
        cfg: {},
        accountId: "default",
        buttons: expect.any(Array),
      }),
    );
  });

  it("skips the Telegram outbound adapter when runtime config is unavailable", async () => {
    const { controller, sendMessageTelegram, telegramOutbound } = await createControllerHarness();
    (controller as any).lastRuntimeConfig = undefined;
    ((controller as any).api as { config?: unknown }).config = undefined;

    await (controller as any).sendTelegramTextChunk(
      telegramOutbound,
      {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      "Hello from fallback",
      {
        buttons: [[{ text: "Resume", callback_data: "codexapp:test-token" }]],
      },
    );

    expect(telegramOutbound.sendPayload).not.toHaveBeenCalled();
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "Hello from fallback",
      expect.objectContaining({
        accountId: "default",
        buttons: expect.any(Array),
      }),
    );
  });

  it("preserves Telegram buttons when the outbound adapter lacks sendPayload", async () => {
    const { controller, sendMessageTelegram } =
      await createControllerHarnessWithoutTelegramPayloadSupport();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    expect(reply).toEqual({});
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Binding: Discord Thread"),
      expect.objectContaining({
        accountId: "default",
        buttons: expect.any(Array),
      }),
    );
  });

  it("skips the Discord outbound adapter when runtime config is unavailable", async () => {
    const { controller, sendComponentMessage, discordOutbound } = await createControllerHarness();
    (controller as any).lastRuntimeConfig = undefined;
    ((controller as any).api as { config?: unknown }).config = undefined;
    (((controller as any).api.runtime.channel.outbound as { loadAdapter?: unknown }).loadAdapter as any) =
      vi.fn(async (channel: string) => (channel === "discord" ? discordOutbound : undefined));

    await (controller as any).sendDiscordPicker(
      {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      {
        text: "Discord fallback picker",
        buttons: [[{ text: "Resume", callback_data: "codexapp:test-token" }]],
      },
    );

    expect(discordOutbound.sendPayload).not.toHaveBeenCalled();
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: "Discord fallback picker",
      }),
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("shows pending default controls when the bound thread is not materialized yet", async () => {
    const { controller, sendMessageTelegram, clientMock } = await createControllerHarness();
    clientMock.readThreadState.mockRejectedValue(
      new Error(
        "thread thread-1 is not materialized yet; includeTurns is unavailable before first user message",
      ),
    );
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    expect(reply).toEqual({});
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    const firstCall = sendMessageTelegram.mock.calls[0] as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string; callback_data: string }>> }]
      | undefined;
    const text = firstCall?.[1] ?? "";
    const buttons = firstCall?.[2]?.buttons ?? [];

    expect(text).toContain("Model: unknown");
    expect(text).toContain("saved as defaults until then");
    expect(buttons).toHaveLength(5);
    expect(buttons[0][0].text).toBe("Select Model");
    expect(buttons[0][1].text).toBe("Reasoning: Default");
    expect(buttons[1][0].text).toBe("Fast: toggle");
    expect(buttons[1][1].text).toBe("Permissions: toggle");
  });

  it("hides the fast button on status controls when the current model does not support it", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      preferences: {
        preferredModel: "openai/gpt-5.2-codex",
        preferredServiceTier: "fast",
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );
    expect(reply).toEqual({});
    const firstCall = sendMessageTelegram.mock.calls[0] as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string; callback_data: string }>> }]
      | undefined;
    const buttons = firstCall?.[2]?.buttons ?? [];

    expect(buttons[1]).toHaveLength(1);
    expect(buttons[1][0].text).toBe("Permissions: toggle");
    expect(buttons[4][0].text).toBe("Skills");
    expect(buttons[4][1].text).toBe("MCPs");
    const kinds = buttons.flatMap((row: Array<{ callback_data: string }>) => {
      return row.map((button) => {
        const token = button.callback_data.split(":").pop() ?? "";
        return (controller as any).store.getCallback(token)?.kind;
      });
    });
    expect(kinds).not.toContain("toggle-fast");
  });

  it("renders saved conversation preferences in cas_status even if thread reads lag behind", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      permissionsMode: "full-access",
      preferences: {
        preferredModel: "openai/gpt-5.3-codex",
        preferredReasoningEffort: "high",
        preferredServiceTier: "fast",
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );
    expect(reply).toEqual({});
    const firstCall = sendMessageTelegram.mock.calls[0] as unknown as [string, string] | undefined;
    const text = firstCall?.[1] ?? "";
    expect(text).toContain("Binding: Discord Thread (openclaw)");
    expect(text).toContain("Model: openai/gpt-5.3-codex · reasoning high");
    expect(text).toContain("Fast mode: off");
    expect(text).toContain("Permissions: Full Access");
  });

  it("sends the status card directly to Discord with interactive controls", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand("cas_status", buildDiscordCommandContext({
      commandBody: "/cas_status",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));

    expect(reply).toEqual({
      text: "Sent Codex status controls to this Discord conversation.",
    });
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Binding: Discord Thread (openclaw)"),
        blocks: expect.arrayContaining([
          expect.objectContaining({
            buttons: expect.arrayContaining([
              expect.objectContaining({ label: "Select Model" }),
            ]),
          }),
        ]),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("applies model, fast, and yolo flags from cas_status", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        args: "--model gpt-5.4 --fast --yolo",
        commandBody: "/cas_status --model gpt-5.4 --fast --yolo",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(binding?.preferences?.preferredModel).toBe("gpt-5.4");
    expect(binding?.preferences?.preferredServiceTier).toBe("fast");
    expect(clientMock.setThreadModel).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: "session-1",
      threadId: "thread-1",
      model: "gpt-5.4",
    });
    expect(clientMock.setThreadServiceTier).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: "session-1",
      threadId: "thread-1",
      serviceTier: "fast",
    });
    expect(reply).toEqual({});
    const firstCall = sendMessageTelegram.mock.calls[0] as unknown as [string, string] | undefined;
    const text = firstCall?.[1] ?? "";
    expect(text).toContain("Model: gpt-5.4");
    expect(text).toContain("Fast mode: on");
    expect(text).toContain("Permissions: Full Access");
  });

  it("applies em-dash model, fast, and yolo flags from cas_status", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        args: "—model gpt-5.4 —fast —yolo",
        commandBody: "/cas_status —model gpt-5.4 —fast —yolo",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(binding?.preferences?.preferredModel).toBe("gpt-5.4");
    expect(binding?.preferences?.preferredServiceTier).toBe("fast");
    expect(clientMock.setThreadModel).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: "session-1",
      threadId: "thread-1",
      model: "gpt-5.4",
    });
    expect(clientMock.setThreadServiceTier).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: "session-1",
      threadId: "thread-1",
      serviceTier: "fast",
    });
    expect(reply).toEqual({});
    const firstCall = sendMessageTelegram.mock.calls[0] as unknown as [string, string] | undefined;
    const text = firstCall?.[1] ?? "";
    expect(text).toContain("Model: gpt-5.4");
    expect(text).toContain("Fast mode: on");
    expect(text).toContain("Permissions: Full Access");
  });


  it("parses unicode em dash --sync for cas_rename and renames the Telegram topic", async () => {
    const { controller, clientMock, renameTopic } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Old Name",
      updatedAt: Date.now(),
    });
    clientMock.setThreadName = vi.fn(async () => ({
      threadId: "thread-1",
      threadName: "New Topic Name",
    }));

    const reply = await controller.handleCommand(
      "cas_rename",
      buildTelegramCommandContext({
        args: "—sync New Topic Name",
        commandBody: "/cas_rename —sync New Topic Name",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    expect(clientMock.setThreadName).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: "session-1",
      threadId: "thread-1",
      name: "New Topic Name",
    });
    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "New Topic Name",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(reply).toEqual({ text: 'Renamed the Codex thread to "New Topic Name".' });
  });

  it("parses unicode em dash --sync for cas_resume and renames the Telegram topic", async () => {
    const { controller, renameTopic, sendMessageTelegram } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "—sync thread-1",
        commandBody: "/cas_resume —sync thread-1",
        messageThreadId: 456,
      }),
    );

    const token = extractTelegramCallbackToken(reply, "Discord Thread");

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      callback: { payload: token },
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "Discord Thread (openclaw)",
      expect.objectContaining({ accountId: "default" }),
    );
    const lastCall = sendMessageTelegram.mock.calls.at(-1) as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string }>>; messageThreadId?: number }]
      | undefined;
    expect(lastCall?.[0]).toBe("123");
    expect(lastCall?.[1]).toContain("Binding: Discord Thread (openclaw)");
    expect(lastCall?.[2]?.messageThreadId).toBe(456);
    expect(lastCall?.[2]?.buttons?.flat().map((button) => button.text)).toEqual(
      expect.arrayContaining(["Refresh", "Detach"]),
    );
  });

  it("pins the Telegram status message and unpins it on detach", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    const fetchMock = vi.mocked(fetch);
    vi.spyOn(controller as any, "loadTelegramRuntimeApi").mockResolvedValue(undefined);
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      threadTitle: "Discord Thread",
      workspaceDir: "/repo/openclaw",
    });

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      callback: { payload: callback.token },
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-token/pinChatMessage",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(
      expect.objectContaining({
        chat_id: "123",
        message_id: 1,
      }),
    );
    const lastCall = sendMessageTelegram.mock.calls.at(-1) as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string }>> }]
      | undefined;
    expect(lastCall?.[1]).toContain("Binding: Discord Thread (openclaw)");
    expect(
      sendMessageTelegram.mock.calls.some((call) =>
        String((call as unknown as [string, string])[1]).includes("Codex thread bound."),
      ),
    ).toBe(false);
    expect(lastCall?.[2]?.buttons?.flat().map((button) => button.text)).toEqual(
      expect.arrayContaining(["Refresh", "Detach"]),
    );
    expect(
      (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toEqual(
      expect.objectContaining({
        pinnedBindingMessage: {
          provider: "telegram",
          messageId: "1",
          chatId: "123",
        },
      }),
    );

    await controller.handleCommand(
      "cas_detach",
      buildTelegramCommandContext({
        commandBody: "/cas_detach",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "binding-1" })),
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-token/unpinChatMessage",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("uses Telegram runtime API helpers to pin and unpin status messages when available", async () => {
    const { controller } = await createControllerHarness();
    const pinMessageTelegram = vi.fn(async () => ({ ok: true }));
    const unpinMessageTelegram = vi.fn(async () => ({ ok: true }));
    vi.spyOn(controller as any, "loadTelegramRuntimeApi").mockResolvedValue({
      pinMessageTelegram,
      unpinMessageTelegram,
    });
    const fetchMock = vi.mocked(fetch);
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      threadTitle: "Discord Thread",
      workspaceDir: "/repo/openclaw",
    });

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      callback: { payload: callback.token },
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(pinMessageTelegram).toHaveBeenCalledWith(
      "123",
      "1",
      expect.objectContaining({
        cfg: {},
        accountId: "default",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await controller.handleCommand(
      "cas_detach",
      buildTelegramCommandContext({
        commandBody: "/cas_detach",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "binding-1" })),
      }),
    );

    expect(unpinMessageTelegram).toHaveBeenCalledWith(
      "123",
      "1",
      expect.objectContaining({
        cfg: {},
        accountId: "default",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins the Discord status message and unpins it on detach", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    const fetchMock = vi.mocked(fetch);
    vi.spyOn(controller as any, "loadDiscordRuntimeApi").mockResolvedValue(undefined);
    vi.spyOn(controller as any, "resolveDiscordBotToken").mockResolvedValue("discord-token");
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      threadId: "thread-1",
      threadTitle: "Discord Thread",
      workspaceDir: "/repo/openclaw",
    });

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      conversationId: "channel:chan-1",
      interaction: {
        payload: callback.token,
      },
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        clearButtons: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/channel%3Achan-1/pins/discord-component-1",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bot discord-token",
        }),
      }),
    );
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Binding: Discord Thread (openclaw)"),
        blocks: expect.arrayContaining([
          expect.objectContaining({
            buttons: expect.arrayContaining([
              expect.objectContaining({ label: "Refresh" }),
              expect.objectContaining({ label: "Detach" }),
            ]),
          }),
        ]),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
    expect(
      (controller as any).store.getBinding({
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      }),
    ).toEqual(
      expect.objectContaining({
        pinnedBindingMessage: {
          provider: "discord",
          messageId: "discord-component-1",
          channelId: "channel:chan-1",
        },
      }),
    );

    await controller.handleCommand(
      "cas_detach",
      buildDiscordCommandContext({
        commandBody: "/cas_detach",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "binding-1" })),
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/channel%3Achan-1/pins/discord-component-1",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization: "Bot discord-token",
        }),
      }),
    );
  });

  it("uses Discord runtime API helpers to pin and unpin status messages when available", async () => {
    const { controller } = await createControllerHarness();
    const pinMessageDiscord = vi.fn(async () => ({ ok: true }));
    const unpinMessageDiscord = vi.fn(async () => ({ ok: true }));
    const fetchMock = vi.mocked(fetch);
    vi.spyOn(controller as any, "loadDiscordRuntimeApi").mockResolvedValue({
      pinMessageDiscord,
      unpinMessageDiscord,
    });
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      threadId: "thread-1",
      threadTitle: "Discord Thread",
      workspaceDir: "/repo/openclaw",
    });

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      conversationId: "channel:chan-1",
      interaction: {
        payload: callback.token,
      },
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        clearButtons: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(pinMessageDiscord).toHaveBeenCalledWith(
      "channel:chan-1",
      "discord-component-1",
      expect.objectContaining({
        cfg: {},
        accountId: "default",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await controller.handleCommand(
      "cas_detach",
      buildDiscordCommandContext({
        commandBody: "/cas_detach",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "binding-1" })),
      }),
    );

    expect(unpinMessageDiscord).toHaveBeenCalledWith(
      "channel:chan-1",
      "discord-component-1",
      expect.objectContaining({
        cfg: {},
        accountId: "default",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not persist detached-thread cache entries after detach", async () => {
    const { controller, stateDir } = await createControllerHarness();
    const conversation = {
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
    } as const;
    await (controller as any).store.upsertBinding({
      conversation,
      sessionKey: buildPluginSessionKey("thread-1"),
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    await (controller as any).unbindConversation(conversation);

    const raw = fs.readFileSync(
      path.join(stateDir, PLUGIN_ID, "state.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual(
      expect.not.objectContaining({
        recentDetachedThreads: expect.anything(),
      }),
    );
  });

  it("replays pending cas_resume --sync effects after approval hydrates on the next resume command", async () => {
    const { controller, clientMock, renameTopic, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.readThreadContext = vi.fn(async () => ({
      lastUserMessage: "What were we doing here?",
      lastAssistantMessage: "We were working on the app-server lifetime refactor.",
    }));
    const requestConversationBinding = vi
      .fn()
      .mockResolvedValueOnce({
        status: "pending" as const,
        reply: { text: "Plugin bind approval required" },
      });

    const pickerReply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--sync thread-1",
        commandBody: "/cas_resume --sync thread-1",
        messageThreadId: 456,
      }),
    );

    const token = extractTelegramCallbackToken(pickerReply, "Discord Thread");
    const interactiveReply = vi.fn(async () => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      callback: { payload: token },
      requestConversationBinding,
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: interactiveReply,
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(interactiveReply).toHaveBeenCalledWith({
      text: "Plugin bind approval required",
      buttons: undefined,
    });
    expect((controller as any).store.getPendingBind({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
    })).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        syncTopic: true,
        notifyBound: true,
      }),
    );

    const hydratedReply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--sync",
        commandBody: "/cas_resume --sync",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    await flushAsyncWork();

    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "Discord Thread (openclaw)",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(hydratedReply).toEqual({ text: "Bound this conversation to Codex." });
    const hydratedLastCall = sendMessageTelegram.mock.calls.at(-1) as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string }>>; messageThreadId?: number }]
      | undefined;
    expect(hydratedLastCall?.[0]).toBe("123");
    expect(hydratedLastCall?.[1]).toContain("Binding: Discord Thread (openclaw)");
    expect(hydratedLastCall?.[2]?.messageThreadId).toBe(456);
    expect(hydratedLastCall?.[2]?.buttons?.flat().map((button) => button.text)).toEqual(
      expect.arrayContaining(["Refresh", "Detach"]),
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "Last User Request in Thread:",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "Last Agent Reply in Thread:",
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("retries an incomplete cas_resume bind before falling back to the picker", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      syncTopic: true,
      notifyBound: true,
      updatedAt: Date.now(),
    });
    const requestConversationBinding = vi.fn(async () => ({
      status: "pending" as const,
      reply: { text: "Plugin bind approval required" },
    }));

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--sync",
        commandBody: "/cas_resume --sync",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => null),
        requestConversationBinding,
      }),
    );

    expect(reply).toEqual({ text: "Plugin bind approval required" });
    expect(requestConversationBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("Bind this conversation to Codex thread Discord Thread."),
      }),
    );
  });

  it("rebinds an incomplete cas_resume bind when the retry is approved immediately", async () => {
    const { controller, renameTopic, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.readThreadContext = vi.fn(async () => ({
      lastUserMessage: "What were we doing here?",
      lastAssistantMessage: "We were working on the app-server lifetime refactor.",
    }));

    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      syncTopic: true,
      notifyBound: true,
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--sync",
        commandBody: "/cas_resume --sync",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => null),
        requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      }),
    );

    await flushAsyncWork();

    expect(reply).toEqual({ text: "Bound this conversation to Codex." });
    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "Discord Thread (openclaw)",
      expect.objectContaining({ accountId: "default" }),
    );
    const reboundLastCall = sendMessageTelegram.mock.calls.at(-1) as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string }>>; messageThreadId?: number }]
      | undefined;
    expect(reboundLastCall?.[0]).toBe("123");
    expect(reboundLastCall?.[1]).toContain("Binding: Discord Thread (openclaw)");
    expect(reboundLastCall?.[2]?.messageThreadId).toBe(456);
    expect(reboundLastCall?.[2]?.buttons?.flat().map((button) => button.text)).toEqual(
      expect.arrayContaining(["Refresh", "Detach"]),
    );
    expect(
      (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
      }),
    );
    expect(
      (controller as any).store.getPendingBind({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toBeNull();
  });

  it("applies pending bind effects immediately when core reports the bind was approved", async () => {
    const { controller, renameTopic, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.readThreadContext = vi.fn(async () => ({
      lastUserMessage: "What were we doing here?",
      lastAssistantMessage: "We were working on the app-server lifetime refactor.",
    }));

    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      syncTopic: true,
      notifyBound: true,
      updatedAt: Date.now(),
    });

    await controller.handleConversationBindingResolved({
      status: "approved",
      binding: {
        bindingId: "binding-1",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/plugins/codex",
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
        threadId: 456,
        boundAt: Date.now(),
      },
      decision: "allow-once",
      request: {
        summary: "Bind this conversation to Codex thread Discord Thread.",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "123:topic:456",
          parentConversationId: "123",
          threadId: 456,
        },
      },
    } as any);

    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "Discord Thread (openclaw)",
      expect.objectContaining({ accountId: "default" }),
    );
    const approvedLastCall = sendMessageTelegram.mock.calls.at(-1) as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string }>>; messageThreadId?: number }]
      | undefined;
    expect(approvedLastCall?.[0]).toBe("123");
    expect(approvedLastCall?.[1]).toContain("Binding: Discord Thread (openclaw)");
    expect(approvedLastCall?.[2]?.messageThreadId).toBe(456);
    expect(approvedLastCall?.[2]?.buttons?.flat().map((button) => button.text)).toEqual(
      expect.arrayContaining(["Refresh", "Detach"]),
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "Last User Request in Thread:",
      expect.objectContaining({ accountId: "default", messageThreadId: 456 }),
    );
    expect(
      (controller as any).store.getPendingBind({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toBeNull();
  });

  it("recovers an approved bind without pending local state from the runtime session binding", async () => {
    const { controller } = await createControllerHarness();
    registerOwnedSessionBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      sessionKey: buildPluginSessionKey("thread-1"),
      metadata: {
        workspaceDir: "/repo/openclaw",
        threadTitle: "Discord Thread",
      },
    });

    await controller.handleConversationBindingResolved({
      status: "approved",
      binding: {
        bindingId: "binding-1",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/plugins/codex",
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
        threadId: 456,
        boundAt: Date.now(),
      },
      decision: "allow-once",
      request: {
        summary: "Bind this conversation to Codex thread Discord Thread.",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "123:topic:456",
          parentConversationId: "123",
          threadId: 456,
        },
      },
    } as any);

    expect(
      (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        threadTitle: "Discord Thread",
      }),
    );
  });

  it("does not recover an approved bind from legacy summary payload text alone", async () => {
    const { controller } = await createControllerHarness();
    const legacySummary = `Bind this conversation to Codex thread Discord Thread. [oc-cas-recovery:${Buffer.from(
      JSON.stringify({
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        threadTitle: "Discord Thread",
      }),
      "utf8",
    ).toString("base64url")}]`;

    await controller.handleConversationBindingResolved({
      status: "approved",
      binding: {
        bindingId: "binding-1",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/plugins/codex",
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
        threadId: 456,
        boundAt: Date.now(),
      },
      decision: "allow-once",
      request: {
        summary: legacySummary,
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "123:topic:456",
          parentConversationId: "123",
          threadId: 456,
        },
      },
    } as any);

    expect(
      (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toBeNull();
  });

  it("still sends the bound status output when the approval restore hits a missing rollout error", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.readThreadState = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("codex app server rpc error (-32600): no rollout found for thread id thread-1"),
      )
      .mockResolvedValue({
        threadId: "thread-1",
        threadName: "Discord Thread",
        model: "openai/gpt-5.4",
        cwd: "/repo/openclaw",
        serviceTier: "default",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });

    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      syncTopic: false,
      notifyBound: true,
      updatedAt: Date.now(),
    });

    await expect(
      controller.handleConversationBindingResolved({
        status: "approved",
        binding: {
          bindingId: "binding-1",
          pluginId: "openclaw-codex-app-server",
          pluginRoot: "/plugins/codex",
          channel: "telegram",
          accountId: "default",
          conversationId: "123:topic:456",
          parentConversationId: "123",
          threadId: 456,
          boundAt: Date.now(),
        },
        decision: "allow-once",
        request: {
          summary: "Bind this conversation to Codex thread Discord Thread.",
          conversation: {
            channel: "telegram",
            accountId: "default",
            conversationId: "123:topic:456",
            parentConversationId: "123",
            threadId: 456,
          },
        },
      } as any),
    ).resolves.toBeUndefined();

    const approvedLastCall = sendMessageTelegram.mock.calls.at(-1) as
      | [string, string, { buttons?: Array<Array<{ text: string }>>; messageThreadId?: number }]
      | undefined;
    expect(approvedLastCall?.[0]).toBe("123");
    expect(approvedLastCall?.[1]).toContain("Binding: Discord Thread (openclaw)");
    expect(approvedLastCall?.[2]?.messageThreadId).toBe(456);
    expect(
      (controller as any).store.getPendingBind({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toBeNull();
  });

  it("still sends the bound status output when a new thread is not materialized yet", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.readThreadState = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("codex app server rpc error (-32600): no rollout found for thread id thread-new"),
      )
      .mockRejectedValueOnce(
        new Error(
          "codex app server rpc error (-32600): thread thread-new is not materialized yet; includeTurns is unavailable before first user message",
        ),
      )
      .mockResolvedValue({
        threadId: "thread-new",
        threadName: "Fresh Thread",
        cwd: "/repo/openclaw",
        model: "openai/gpt-5.4",
        serviceTier: "default",
      });
    (controller as any).client.readThreadContext = vi.fn().mockRejectedValue(
      new Error(
        "codex app server rpc error (-32600): thread thread-new is not materialized yet; includeTurns is unavailable before first user message",
      ),
    );

    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-new",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Fresh Thread",
      syncTopic: false,
      notifyBound: true,
      updatedAt: Date.now(),
    });

    await expect(
      controller.handleConversationBindingResolved({
        status: "approved",
        binding: {
          bindingId: "binding-1",
          pluginId: "openclaw-codex-app-server",
          pluginRoot: "/plugins/codex",
          channel: "telegram",
          accountId: "default",
          conversationId: "123:topic:456",
          parentConversationId: "123",
          threadId: 456,
          boundAt: Date.now(),
        },
        decision: "allow-once",
        request: {
          summary: "Bind this conversation to Codex thread Fresh Thread.",
          conversation: {
            channel: "telegram",
            accountId: "default",
            conversationId: "123:topic:456",
            parentConversationId: "123",
            threadId: 456,
          },
        },
      } as any),
    ).resolves.toBeUndefined();

    const approvedLastCall = sendMessageTelegram.mock.calls.at(-1) as
      | [string, string, { buttons?: Array<Array<{ text: string }>>; messageThreadId?: number }]
      | undefined;
    expect(approvedLastCall?.[0]).toBe("123");
    expect(approvedLastCall?.[1]).toContain("Binding: Fresh Thread (openclaw)");
    expect(approvedLastCall?.[1]).toContain("Thread: thread-new");
    expect(approvedLastCall?.[2]?.messageThreadId).toBe(456);
    expect(
      (controller as any).store.getPendingBind({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toBeNull();
  });

  it("still sends the bound status output when a new thread replay read reports thread not loaded", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.readThreadState = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("codex app server rpc error (-32600): no rollout found for thread id thread-new"),
      )
      .mockRejectedValueOnce(
        new Error("codex app server rpc error (-32600): thread not loaded: thread-new"),
      )
      .mockResolvedValue({
        threadId: "thread-new",
        threadName: "Fresh Thread",
        cwd: "/repo/openclaw",
        model: "openai/gpt-5.4",
        serviceTier: "default",
      });
    (controller as any).client.readThreadContext = vi.fn().mockRejectedValue(
      new Error("codex app server rpc error (-32600): thread not loaded: thread-new"),
    );

    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-new",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Fresh Thread",
      syncTopic: false,
      notifyBound: true,
      updatedAt: Date.now(),
    });

    await expect(
      controller.handleConversationBindingResolved({
        status: "approved",
        binding: {
          bindingId: "binding-1",
          pluginId: "openclaw-codex-app-server",
          pluginRoot: "/plugins/codex",
          channel: "telegram",
          accountId: "default",
          conversationId: "123:topic:456",
          parentConversationId: "123",
          threadId: 456,
          boundAt: Date.now(),
        },
        decision: "allow-once",
        request: {
          summary: "Bind this conversation to Codex thread Fresh Thread.",
          conversation: {
            channel: "telegram",
            accountId: "default",
            conversationId: "123:topic:456",
            parentConversationId: "123",
            threadId: 456,
          },
        },
      } as any),
    ).resolves.toBeUndefined();

    const approvedLastCall = sendMessageTelegram.mock.calls.at(-1) as
      | [string, string, { buttons?: Array<Array<{ text: string }>>; messageThreadId?: number }]
      | undefined;
    expect(approvedLastCall?.[0]).toBe("123");
    expect(approvedLastCall?.[1]).toContain("Binding: Fresh Thread (openclaw)");
    expect(approvedLastCall?.[1]).toContain("Thread: thread-new");
    expect(approvedLastCall?.[2]?.messageThreadId).toBe(456);
    expect(
      (controller as any).store.getPendingBind({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toBeNull();
  });

  it("preserves pending model and yolo overrides when approval completes after resume-thread selection", async () => {
    const { controller } = await createControllerHarness();

    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      permissionsMode: "full-access",
      preferences: {
        preferredModel: "gpt-5.3-codex-spark",
        updatedAt: Date.now(),
      },
      syncTopic: false,
      notifyBound: false,
      updatedAt: Date.now(),
    });

    await controller.handleConversationBindingResolved({
      status: "approved",
      binding: {
        bindingId: "binding-1",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/plugins/codex",
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
        threadId: 456,
        boundAt: Date.now(),
      },
      decision: "allow-once",
      request: {
        summary: "Bind this conversation to Codex thread Discord Thread.",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "123:topic:456",
          parentConversationId: "123",
          threadId: 456,
        },
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(binding?.preferences?.preferredModel).toBe("gpt-5.3-codex-spark");
  });

  it("clears pending bind state immediately when core reports the bind was denied", async () => {
    const { controller, renameTopic, sendMessageTelegram } = await createControllerHarness();

    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      syncTopic: true,
      notifyBound: true,
      updatedAt: Date.now(),
    });

    await controller.handleConversationBindingResolved({
      status: "denied",
      decision: "deny",
      request: {
        summary: "Bind this conversation to Codex thread Discord Thread.",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "123:topic:456",
          parentConversationId: "123",
          threadId: 456,
        },
      },
    } as any);

    expect(renameTopic).not.toHaveBeenCalled();
    expect(sendMessageTelegram).not.toHaveBeenCalled();
    expect(
      (controller as any).store.getPendingBind({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toBeNull();
  });

  it("preserves syncTopic on Telegram resume pickers and renames the topic after callback bind", async () => {
    const { controller, renameTopic } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      syncTopic: true,
    });

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      callback: {
        payload: callback.token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "Discord Thread (openclaw)",
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("uses the live thread title during resume callback binding when core returns one", async () => {
    const { controller, clientMock, renameTopic, sendMessageTelegram } = await createControllerHarness();
    clientMock.readThreadState.mockResolvedValue({
      threadId: "019d2cbc-9fee-7862-8d02-683dfef71851",
      model: "gpt-5.4",
      modelProvider: "openai",
      reasoningEffort: "high",
      cwd: "/repo/openclaw-app-server",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "019d2cbc-9fee-7862-8d02-683dfef71851",
      threadTitle: "What is wrong with this layout?",
      workspaceDir: "/repo/openclaw-app-server",
      syncTopic: true,
    });

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      callback: {
        payload: callback.token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "What is wrong with this layout? (openclaw-app-server)",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(sendMessageTelegram).toHaveBeenCalled();
    expect(
      (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toEqual(
      expect.objectContaining({
        threadId: "019d2cbc-9fee-7862-8d02-683dfef71851",
        threadTitle: "Discord Thread",
      }),
    );
  });

  it("dispatches start-new-thread callbacks through thread creation and binding", async () => {
    const { controller, clientMock } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "start-new-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      workspaceDir: "/repo/openclaw",
    });
    const requestConversationBinding = vi.fn(async () => ({ status: "bound" as const }));

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      requestConversationBinding,
      callback: {
        payload: callback.token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(clientMock.startThread).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: undefined,
      workspaceDir: "/repo/openclaw",
      model: undefined,
    });
    expect(requestConversationBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("Bind this conversation to Codex thread"),
      }),
    );
  });

  it("preserves em-dash model and yolo overrides when New is chosen from the resume picker", async () => {
    const { controller, clientMock } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "—model gpt-5.3-codex-spark —yolo",
        commandBody: "/cas_resume —model gpt-5.3-codex-spark —yolo",
      }),
    );

    const buttons = (reply.channelData as any)?.telegram?.buttons;
    const newCallbackData = buttons?.flat().find((button: { text: string }) => button.text === "New")?.callback_data as
      | string
      | undefined;
    expect(newCallbackData).toMatch(/^codexapp:/);

    const editMessage = vi.fn(async (_payload: any) => {});
    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: newCallbackData?.slice("codexapp:".length) },
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const projectButtons = editMessage.mock.calls.at(-1)?.[0]?.buttons as
      | Array<Array<{ text: string; callback_data: string }>>
      | undefined;
    const projectCallbackData = projectButtons?.[0]?.[0]?.callback_data;
    expect(projectCallbackData).toMatch(/^codexapp:/);

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: projectCallbackData?.slice("codexapp:".length) },
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(clientMock.startThread).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: undefined,
      workspaceDir: "/repo/openclaw",
      model: "gpt-5.3-codex-spark",
    });
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(binding?.preferences?.preferredModel).toBe("gpt-5.3-codex-spark");
  });

  it("sends the Telegram bind approval prompt only once for resume callbacks", async () => {
    const { controller } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
    });
    const reply = vi.fn(async () => {});
    const buttons = [[{ text: "Allow once", callback_data: "pluginbind:approval:o" }]];

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      requestConversationBinding: vi.fn(async () => ({
        status: "pending" as const,
        reply: {
          text: "Plugin bind approval required",
          channelData: {
            telegram: {
              buttons,
            },
          },
        },
      })),
      callback: {
        payload: callback.token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply,
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      text: "Plugin bind approval required",
      buttons,
    });
  });

  it("renders Telegram bind approval buttons from interactive reply blocks", async () => {
    const { controller } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
    });
    const reply = vi.fn(async () => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      requestConversationBinding: vi.fn(async () => ({
        status: "pending" as const,
        reply: {
          text: "Plugin bind approval required",
          interactive: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  {
                    label: "Allow once",
                    value: "pluginbind:approval:o",
                    style: "success",
                  },
                  {
                    label: "Always allow",
                    value: "pluginbind:approval:a",
                    style: "primary",
                  },
                  {
                    label: "Deny",
                    value: "pluginbind:approval:d",
                    style: "danger",
                  },
                ],
              },
            ],
          },
        } as any,
      })),
      callback: {
        payload: callback.token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply,
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(reply).toHaveBeenCalledWith({
      text: "Plugin bind approval required",
      buttons: [
        [
          { text: "Allow once", callback_data: "pluginbind:approval:o", style: "success" },
          { text: "Always allow", callback_data: "pluginbind:approval:a", style: "primary" },
          { text: "Deny", callback_data: "pluginbind:approval:d", style: "danger" },
        ],
      ],
    });
  });

  it("offers compact rename style buttons for cas_rename --sync without a name", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_rename",
      buildTelegramCommandContext({
        args: "--sync",
        commandBody: "/cas_rename --sync",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    expect(reply.text).toContain("Choose a name style");
    const buttons = (reply.channelData as any)?.telegram?.buttons;
    expect(buttons).toHaveLength(2);
    expect(buttons[0][0].text).toBe("Discord Thread (openclaw)");
    expect(buttons[1][0].text).toBe("Discord Thread");
    expect(String(buttons[0][0].callback_data)).toMatch(/^codexapp:/);
    expect(String(buttons[0][0].callback_data).length).toBeLessThan(64);
  });

  it("deduplicates repeated project suffixes in rename style suggestions", async () => {
    const { controller } = await createControllerHarness();
    (controller as any).client.readThreadState = vi.fn(async () => ({
      threadId: "thread-1",
      threadName: "Explore OAuth login for gifgrep (gifgrep) (gifgrep)",
      cwd: "/repo/gifgrep",
    }));
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/gifgrep",
      threadTitle: "Explore OAuth login for gifgrep (gifgrep) (gifgrep)",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_rename",
      buildTelegramCommandContext({
        args: "--sync",
        commandBody: "/cas_rename --sync",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    const buttons = (reply.channelData as any)?.telegram?.buttons;
    expect(buttons).toHaveLength(2);
    expect(buttons[0][0].text).toBe("Explore OAuth login for gifgrep (gifgrep)");
    expect(buttons[1][0].text).toBe("Explore OAuth login for gifgrep");
  });

  it("requests approved conversation binding when binding a Discord thread", async () => {
    const { controller } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      threadId: "thread-1",
      threadTitle: "Discord Thread",
      workspaceDir: "/repo/openclaw",
    });
    const requestConversationBinding = vi.fn(async () => ({ status: "bound" as const }));

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      conversationId: "channel:chan-1",
      interaction: {
        payload: callback.token,
      },
      requestConversationBinding,
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        clearButtons: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(requestConversationBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("Bind this conversation to Codex thread"),
      }),
    );
  });

  it("sends the Discord bind approval prompt only once for resume callbacks", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
    });
    const acknowledge = vi.fn(async () => {});
    const clearComponents = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const requestConversationBinding = vi.fn(async () => ({
      status: "pending" as const,
      reply: {
        text: "Plugin bind approval required",
        channelData: {
          telegram: {
            buttons: [[{ text: "Allow once", callback_data: "pluginbind:approval:o" }]],
          },
        },
      },
    }));

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      requestConversationBinding,
      respond: {
        acknowledge,
        reply,
        followUp: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
        clearComponents,
      },
    } as any);

    expect(sendComponentMessage).toHaveBeenCalledTimes(1);
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: "Plugin bind approval required",
      }),
      expect.objectContaining({ accountId: "default" }),
    );
    expect(discordSdkState.editDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      "message-1",
      {
        text: "Binding approval requested below.",
      },
      expect.objectContaining({ accountId: "default" }),
    );
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge.mock.invocationCallOrder[0]).toBeLessThan(
      requestConversationBinding.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(clearComponents).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("claims inbound Discord messages for raw thread ids after a typed bind", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "who are you?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalled();
  });

  it("matches a Discord binding even when the inbound event includes a parent conversation id", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "What is the CWD?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      parentConversationId: "987654321",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalled();
  });

  it("recovers inbound Discord claims from the public session binding service when local state is missing", async () => {
    const { controller, clientMock, api } = await createControllerHarness();
    const bindingService = getSessionBindingService();
    const resolveByConversation = vi
      .spyOn(bindingService, "resolveByConversation")
      .mockReturnValue({
        bindingId: "binding-1",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:1481858418548412579",
        },
        targetKind: "session",
        status: "active",
        boundAt: Date.now(),
        targetSessionKey: buildPluginSessionKey("thread-1"),
        metadata: {
          pluginId: PLUGIN_ID,
        },
      });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "who are you?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(resolveByConversation).toHaveBeenCalledWith({
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      parentConversationId: undefined,
    });
    expect((api.runtime.channel as any).bindings.resolveByConversation).not.toHaveBeenCalled();
    expect(clientMock.readThreadState).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: buildPluginSessionKey("thread-1"),
        threadId: "thread-1",
      }),
    );
    expect(startTurn).toHaveBeenCalled();
    expect((controller as any).store.getBinding({
      channel: "discord",
      accountId: "default",
      conversationId: "channel:1481858418548412579",
      parentConversationId: undefined,
    })).toEqual(
      expect.objectContaining({
        sessionKey: buildPluginSessionKey("thread-1"),
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
      }),
    );
  });

  it("recovers inbound claims after restart when persisted local binding state is lost", async () => {
    const stateDir = makeStateDir();
    const initial = await createControllerHarness({ stateDir });
    const binding = {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: buildPluginSessionKey("thread-1"),
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      updatedAt: Date.now(),
    };
    await (initial.controller as any).store.upsertBinding(binding);

    const statePath = path.join(stateDir, PLUGIN_ID, "state.json");
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      bindings?: unknown[];
      pendingBinds?: unknown[];
      pendingRequests?: unknown[];
      callbacks?: unknown[];
    };
    persisted.bindings = [];
    fs.writeFileSync(statePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    const { controller, clientMock } = await createControllerHarness({ stateDir });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "who are you?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(clientMock.readThreadState).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: binding.sessionKey,
        threadId: binding.threadId,
      }),
    );
    expect(startTurn).toHaveBeenCalled();
    expect(
      (controller as any).store.getBinding({
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
        parentConversationId: undefined,
      }),
    ).toEqual(
      expect.objectContaining({
        sessionKey: binding.sessionKey,
        threadId: binding.threadId,
        workspaceDir: binding.workspaceDir,
      }),
    );
  });

  it("keeps a local Telegram binding when the runtime session binding only exposes the plugin placeholder session", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      sessionKey: buildPluginSessionKey("thread-1"),
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    vi.spyOn(getSessionBindingService(), "resolveByConversation").mockReturnValue({
      bindingId: "binding-1",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      targetKind: "acp",
      status: "active",
      boundAt: Date.now(),
      targetSessionKey: "plugin-binding:openclaw-codex-app-server:placeholder",
      metadata: {
        pluginId: PLUGIN_ID,
      },
    } as any);
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "who are you?",
      channel: "telegram",
      accountId: "default",
      conversationId: TEST_TELEGRAM_PEER_ID,
      parentConversationId: TEST_TELEGRAM_PEER_ID,
      isGroup: false,
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        existingThreadId: "thread-1",
        sessionKey: buildPluginSessionKey("thread-1"),
        workspaceDir: "/repo/openclaw",
      }),
    );
  });

  it("ignores the legacy runtime bindings surface when the public session binding service resolves a binding", async () => {
    const { controller, clientMock, api } = await createControllerHarness();
    const bindingService = getSessionBindingService();
    vi.spyOn(bindingService, "resolveByConversation").mockReturnValue({
      bindingId: "binding-public",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      targetKind: "session",
      status: "active",
      boundAt: Date.now(),
      targetSessionKey: buildPluginSessionKey("thread-public"),
      metadata: {
        pluginId: PLUGIN_ID,
      },
    });
    ((api.runtime.channel as any).bindings.resolveByConversation as any).mockReturnValue({
      targetSessionKey: buildPluginSessionKey("thread-legacy"),
      metadata: {
        pluginId: PLUGIN_ID,
      },
    });
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-public",
        text: "hello",
      }),
      getThreadId: () => "thread-public",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    const result = await controller.handleInboundClaim({
      content: "who are you?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(clientMock.readThreadState).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: buildPluginSessionKey("thread-public"),
        threadId: "thread-public",
      }),
    );
    expect(clientMock.readThreadState).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: buildPluginSessionKey("thread-legacy"),
        threadId: "thread-legacy",
      }),
    );
    expect((api.runtime.channel as any).bindings.resolveByConversation).not.toHaveBeenCalled();
  });

  it("does not recover from the legacy runtime bindings surface when the public session binding service misses", async () => {
    const { controller, clientMock, api } = await createControllerHarness();
    const bindingService = getSessionBindingService();
    const resolveByConversation = vi
      .spyOn(bindingService, "resolveByConversation")
      .mockReturnValue(null);
    const legacyResolveByConversation = (api.runtime.channel as any).bindings
      .resolveByConversation as ReturnType<typeof vi.fn>;
    legacyResolveByConversation.mockReturnValue({
      targetSessionKey: buildPluginSessionKey("thread-1"),
      metadata: {
        pluginId: PLUGIN_ID,
      },
    });
    const result = await controller.handleInboundClaim({
      content: "who are you?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: false });
    expect(resolveByConversation).toHaveBeenCalled();
    expect(legacyResolveByConversation).not.toHaveBeenCalled();
    expect(clientMock.readThreadState).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: buildPluginSessionKey("thread-1"),
      }),
    );
  });

  it("sends a desync-specific message when a live core binding cannot be recovered", async () => {
    const { controller, api, sendMessageDiscord } = await createControllerHarness();
    vi.spyOn(getSessionBindingService(), "resolveByConversation").mockReturnValue({
      bindingId: "binding-1",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      targetKind: "session",
      status: "active",
      boundAt: Date.now(),
      targetSessionKey: buildPluginSessionKey("thread-1"),
      metadata: {
        pluginId: PLUGIN_ID,
      },
    });
    (controller as any).client.readThreadState = vi.fn(async () => ({ cwd: undefined }));

    const result = await controller.handleInboundClaim({
      content: "who are you?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:1481858418548412579",
      expect.stringContaining("local binding state got out of sync"),
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("prunes a stale local binding when the public session binding service no longer knows it", async () => {
    const { controller, sendMessageDiscord } = await createControllerHarness();
    const conversation = {
      channel: "discord",
      accountId: "default",
      conversationId: "channel:1481858418548412579",
    } as const;
    await (controller as any).store.upsertBinding({
      conversation,
      sessionKey: buildPluginSessionKey("thread-1"),
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    vi.spyOn(getSessionBindingService(), "resolveByConversation").mockReturnValue(null);

    const result = await controller.handleInboundClaim({
      content: "who are you?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: false });
    expect((controller as any).store.getBinding(conversation)).toBeNull();
    expect(sendMessageDiscord).not.toHaveBeenCalled();
  });

  it("uses a raw Discord channel id for the typing lease on inbound claims", async () => {
    const { controller, discordTypingStart } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
    }));

    const result = await controller.handleInboundClaim({
      content: "hello",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(discordTypingStart).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "1481858418548412579",
        accountId: "default",
      }),
    );
  });

  it("skips the Discord typing lease for bound DM inbound claims", async () => {
    const { controller, discordTypingStart } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1177378744822943744",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
    }));

    const result = await controller.handleInboundClaim({
      content: "hello",
      channel: "discord",
      accountId: "default",
      conversationId: "user:1177378744822943744",
      isGroup: false,
      metadata: {},
    });

    expect(result).toEqual({ handled: true });
    expect(discordTypingStart).not.toHaveBeenCalled();
  });

  it("prefers the managed Telegram runtime typing helper over the legacy lease", async () => {
    const { controller, api } = await createControllerHarness();
    const telegramTypingStart = ((api.runtime.channel as any).telegram?.typing
      .start as ReturnType<typeof vi.fn>);
    const sendTypingTelegram = vi.fn(async () => ({ ok: true }));
    vi.spyOn(controller as any, "loadTelegramRuntimeApi").mockResolvedValue({
      sendTypingTelegram,
    });
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "hello",
      reason: "inbound",
    });

    await flushAsyncWork();
    expect(sendTypingTelegram).toHaveBeenCalledWith(
      TEST_TELEGRAM_PEER_ID,
      expect.objectContaining({
        cfg: {},
        accountId: "default",
      }),
    );
    expect(telegramTypingStart).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the Telegram runtime typing helper when the legacy runtime is unavailable", async () => {
    const { controller, api } = await createControllerHarness();
    delete (api.runtime.channel as { telegram?: unknown }).telegram;
    const sendTypingTelegram = vi.fn(async () => ({ ok: true }));
    vi.spyOn(controller as any, "loadTelegramRuntimeApi").mockResolvedValue({
      sendTypingTelegram,
    });
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "hello",
      reason: "inbound",
    });

    await flushAsyncWork();
    expect(sendTypingTelegram).toHaveBeenCalledWith(
      TEST_TELEGRAM_PEER_ID,
      expect.objectContaining({
        cfg: {},
        accountId: "default",
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the Telegram runtime typing lease alive past the old 60s host TTL", async () => {
    vi.useFakeTimers();
    try {
      const { controller } = await createControllerHarness();
      const sendTypingTelegram = vi.fn(async () => ({ ok: true }));
      vi.spyOn(controller as any, "loadTelegramRuntimeApi").mockResolvedValue({
        sendTypingTelegram,
      });

      const lease = await (controller as any).startTelegramRuntimeTypingLease({
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      });

      expect(lease).not.toBeNull();
      expect(sendTypingTelegram).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(59_000);
      const callsBeforeOldTtl = sendTypingTelegram.mock.calls.length;
      expect(callsBeforeOldTtl).toBeGreaterThan(1);

      await vi.advanceTimersByTimeAsync(12_000);
      expect(sendTypingTelegram.mock.calls.length).toBeGreaterThan(callsBeforeOldTtl);

      lease?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to direct Telegram typing when the runtime helper fails its first start", async () => {
    const { controller, api } = await createControllerHarness();
    delete (api.runtime.channel as { telegram?: unknown }).telegram;
    const sendTypingTelegram = vi.fn(async () => {
      throw new Error("runtime typing failed");
    });
    vi.spyOn(controller as any, "loadTelegramRuntimeApi").mockResolvedValue({
      sendTypingTelegram,
    });
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "hello",
      reason: "inbound",
    });

    await flushAsyncWork();
    expect(sendTypingTelegram).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-token/sendChatAction",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("falls back to the direct Telegram typing lease when legacy and runtime helpers are unavailable", async () => {
    const { controller, api } = await createControllerHarness();
    delete (api.runtime.channel as { telegram?: unknown }).telegram;
    vi.spyOn(controller as any, "loadTelegramRuntimeApi").mockResolvedValue(undefined);
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "hello",
      reason: "inbound",
    });

    await flushAsyncWork();
    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-token/sendChatAction",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("uses the Discord runtime typing helper when the legacy runtime is unavailable", async () => {
    const { controller, api } = await createControllerHarness();
    delete (api.runtime.channel as { discord?: { typing?: unknown } }).discord?.typing;
    const sendTypingDiscord = vi.fn(async () => ({ ok: true }));
    vi.spyOn(controller as any, "loadDiscordRuntimeApi").mockResolvedValue({
      sendTypingDiscord,
    });
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      binding: {
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "hello",
      reason: "inbound",
    });

    await flushAsyncWork();
    expect(sendTypingDiscord).toHaveBeenCalledWith(
      "chan-1",
      expect.objectContaining({
        cfg: {},
        accountId: "default",
      }),
    );
  });

  it("resets the cached client profile before compaction when no run is active for that profile", async () => {
    const { controller, clientMock } = await createControllerHarness();
    const closeProfile = vi.fn(async () => {});
    const compactThread = vi.fn(async () => ({
      usage: {
        totalTokens: 1_000,
        contextWindow: 10_000,
        remainingPercent: 90,
      },
    }));
    (controller as any).client = {
      ...clientMock,
      closeProfile,
      compactThread,
    };
    (controller as any).startTypingLease = vi.fn(async () => null);
    (controller as any).sendText = vi.fn(async () => {});

    const binding = {
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      sessionKey: buildPluginSessionKey("thread-1"),
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      permissionsMode: "full-access",
      updatedAt: Date.now(),
    };

    await (controller as any).startCompact({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding,
    });

    expect(closeProfile).toHaveBeenCalledWith("full-access");
    expect(compactThread).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "full-access",
        sessionKey: binding.sessionKey,
        threadId: binding.threadId,
      }),
    );
  });

  it("does not reset the cached client profile before compaction when a run is active for that profile", async () => {
    const { controller, clientMock } = await createControllerHarness();
    const closeProfile = vi.fn(async () => {});
    const compactThread = vi.fn(async () => ({}));
    (controller as any).client = {
      ...clientMock,
      closeProfile,
      compactThread,
    };
    (controller as any).startTypingLease = vi.fn(async () => null);
    (controller as any).sendText = vi.fn(async () => {});
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      profile: "full-access",
      handle: {
        result: new Promise(() => {}),
        queueMessage: vi.fn(async () => false),
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        getThreadId: () => "thread-active",
      },
    });

    const binding = {
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      sessionKey: buildPluginSessionKey("thread-1"),
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      permissionsMode: "full-access",
      updatedAt: Date.now(),
    };

    await (controller as any).startCompact({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding,
    });

    expect(closeProfile).not.toHaveBeenCalled();
    expect(compactThread).toHaveBeenCalled();
  });

  it("forwards inbound Discord image metadata as a localImage turn input item", async () => {
    const { controller, stateDir } = await createControllerHarness();
    const imagePath = path.join(stateDir, "tmp", "inbound.png");
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, "png");
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "looks like a screenshot",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "What is in this image?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1", mediaPath: imagePath, mediaType: "image/png" },
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "What is in this image?",
        input: [
          { type: "text", text: "What is in this image?" },
          { type: "localImage", path: imagePath },
        ],
      }),
    );
  });

  it("supports image-only inbound claims when media metadata is present", async () => {
    const { controller, stateDir } = await createControllerHarness();
    const imagePath = path.join(stateDir, "tmp", "image-only.jpg");
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, "jpg");
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "described",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "",
      channel: "telegram",
      accountId: "default",
      conversationId: TEST_TELEGRAM_PEER_ID,
      isGroup: false,
      metadata: { mediaPath: imagePath, mediaType: "image/jpeg" },
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "",
        input: [{ type: "localImage", path: imagePath }],
      }),
    );
  });

  it("forwards text file inbound media metadata as text turn input", async () => {
    const { controller, stateDir } = await createControllerHarness();
    const filePath = path.join(stateDir, "tmp", "note.txt");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "hello");
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "handled",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "Read this file",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1", mediaPath: filePath, mediaType: "text/plain" },
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Read this file",
        input: [
          { type: "text", text: "Read this file" },
          {
            type: "text",
            text: "Attached file: note.txt\nContent-Type: text/plain\n\nhello",
          },
        ],
      }),
    );
  });

  it("detects markdown attachments by file extension when mime metadata is absent", async () => {
    const { controller, stateDir } = await createControllerHarness();
    const filePath = path.join(stateDir, "tmp", "README.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "# Heading\n\nBody text.\n");
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "handled",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "",
      channel: "telegram",
      accountId: "default",
      conversationId: TEST_TELEGRAM_PEER_ID,
      isGroup: false,
      metadata: { mediaPath: filePath },
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "",
        input: [
          {
            type: "text",
            text: "Attached file: README.md\n\n# Heading\n\nBody text.\n",
          },
        ],
      }),
    );
  });

  it("still ignores unsupported binary document attachments", async () => {
    const { controller, stateDir } = await createControllerHarness();
    const filePath = path.join(stateDir, "tmp", "manual.pdf");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "%PDF");
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "handled",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "Read this document",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1", mediaPath: filePath, mediaType: "application/pdf" },
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Read this document",
        input: [{ type: "text", text: "Read this document" }],
      }),
    );
  });

  it("implements a plan by switching back to default mode with a short prompt", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "run-prompt",
      token: "run-prompt-token",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      prompt: "Implement the plan.",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "openai/gpt-5.4",
          developerInstructions: null,
        },
      },
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "implemented",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;
    const reply = vi.fn(async () => {});
    const followUp = vi.fn(async () => {});

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply,
        followUp,
        editMessage: vi.fn(async () => {}),
        clearComponents: vi.fn(async () => {}),
      },
    } as any);

    expect(reply).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledWith({ text: "Sent the plan to Codex.", ephemeral: true });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Implement the plan.",
        collaborationMode: {
          mode: "default",
          settings: {
            model: "openai/gpt-5.4",
            developerInstructions: null,
          },
        },
      }),
    );
  });

  it("supports cas_plan off to interrupt an active plan run", async () => {
    const { controller } = await createControllerHarness();
    const interrupt = vi.fn(async () => {});
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "plan",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "planned" }),
        queueMessage: vi.fn(async () => true),
        getThreadId: () => "thread-1",
        interrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });

    const reply = await controller.handleCommand(
      "cas_plan",
      buildDiscordCommandContext({
        args: "off",
        commandBody: "/cas_plan off",
      }),
    );

    expect(interrupt).toHaveBeenCalled();
    expect(reply).toEqual({
      text: "Exited Codex plan mode. Future turns will use default coding mode.",
    });
  });

  it("restarts a lingering active plan run instead of queueing a normal inbound message into it", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const staleQueueMessage = vi.fn(async () => true);
    const staleInterrupt = vi.fn(async () => {});
    (controller as any).activeRuns.set("discord::default::channel:1481858418548412579::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      workspaceDir: "/repo/openclaw",
      mode: "plan",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "stale-plan" }),
        queueMessage: staleQueueMessage,
        getThreadId: () => "thread-1",
        interrupt: staleInterrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "And? Build it?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(staleQueueMessage).not.toHaveBeenCalled();
    expect(staleInterrupt).toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalled();
  });

  it("passes trusted local media roots when sending a Telegram plan attachment", async () => {
    const { controller, sendMessageTelegram, stateDir } = await createControllerHarness();
    const attachmentPath = path.join(stateDir, "tmp", "plan.md");
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, "# Plan\n");

    const sent = await (controller as any).sendReply(
      {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      {
        mediaUrl: attachmentPath,
      },
    );

    expect(sent).toBe(true);
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      TEST_TELEGRAM_PEER_ID,
      "",
      expect.objectContaining({
        mediaUrl: attachmentPath,
        mediaLocalRoots: expect.arrayContaining([stateDir, path.dirname(attachmentPath)]),
      }),
    );
  });

  it("passes trusted local media roots when sending a Discord plan attachment", async () => {
    const { controller, sendMessageDiscord, stateDir } = await createControllerHarness();
    const attachmentPath = path.join(stateDir, "tmp", "plan.md");
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, "# Plan\n");

    const sent = await (controller as any).sendReply(
      {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1177378744822943744",
      },
      {
        mediaUrl: attachmentPath,
      },
    );

    expect(sent).toBe(true);
    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "user:1177378744822943744",
      "",
      expect.objectContaining({
        mediaUrl: attachmentPath,
        mediaLocalRoots: expect.arrayContaining([stateDir, path.dirname(attachmentPath)]),
      }),
    );
  });

  it("restarts a Discord bound run for a fresh inbound prompt instead of steering the active run", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const staleInterrupt = vi.fn(async () => {});
    const staleQueueMessage = vi.fn(async () => true);
    (controller as any).activeRuns.set("discord::default::channel:1481858418548412579::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "stale" }),
        queueMessage: staleQueueMessage,
        getThreadId: () => "thread-1",
        interrupt: staleInterrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "who are you?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(staleQueueMessage).not.toHaveBeenCalled();
    expect(staleInterrupt).toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        existingThreadId: "thread-1",
        prompt: "who are you?",
      }),
    );
  });

  it("restarts an active run for a fresh prompt instead of queueing it as steer", async () => {
    const { controller, api } = await createControllerHarness();
    const staleInterrupt = vi.fn(async () => {});
    const staleQueueMessage = vi.fn(async () => false);
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "stale" }),
        queueMessage: staleQueueMessage,
        getThreadId: () => "thread-1",
        interrupt: staleInterrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "fresh",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    await (controller as any).startTurn({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      binding: {
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "command",
    });

    expect(staleQueueMessage).not.toHaveBeenCalled();
    expect(staleInterrupt).toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalled();
    expect(api.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("restarting active run for fresh prompt"),
    );
  });

  it("restarts instead of queueing when structured text input is provided to an active run", async () => {
    const { controller } = await createControllerHarness();
    const staleInterrupt = vi.fn(async () => {});
    const staleQueueMessage = vi.fn(async () => true);
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "stale" }),
        queueMessage: staleQueueMessage,
        getThreadId: () => "thread-1",
        interrupt: staleInterrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "fresh",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    await (controller as any).startTurn({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      binding: {
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "Read this file",
      input: [
        { type: "text", text: "Read this file" },
        { type: "text", text: "Attached file: note.txt\n\nhello" },
      ],
      reason: "inbound",
    });

    expect(staleQueueMessage).not.toHaveBeenCalled();
    expect(staleInterrupt).toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalled();
  });

  it("does not send the plan keepalive after a questionnaire is already visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T13:10:00-04:00"));
    try {
      const harness = await createControllerHarness();
      const { controller } = harness;
      const { sendMessageTelegram } = harness;
      let resolveResult: ((value: unknown) => void) | undefined;
      const result = new Promise((resolve) => {
        resolveResult = resolve;
      });
      (controller as any).client.startTurn = vi.fn((params: any) => {
        void Promise.resolve().then(() =>
          params.onPendingInput?.({
            requestId: "req-plan-1",
            options: [],
            expiresAt: Date.now() + 7 * 24 * 60 * 60_000,
            method: "item/tool/requestUserInput",
            questionnaire: {
              currentIndex: 0,
              questions: [
                {
                  index: 0,
                  id: "breakfast",
                  header: "Breakfast",
                  prompt: "Do you like cereal or bagels?",
                  options: [
                    { key: "A", label: "Cereal (Recommended)", description: "Choose cereal." },
                    { key: "B", label: "Bagels", description: "Choose bagels." },
                  ],
                  guidance: [],
                  allowFreeform: true,
                },
              ],
              answers: [null],
              responseMode: "structured",
            },
          }),
        );
        return {
          result,
          getThreadId: () => "thread-1",
          queueMessage: vi.fn(async () => false),
          interrupt: vi.fn(async () => {}),
          isAwaitingInput: () => true,
          submitPendingInput: vi.fn(async () => false),
          submitPendingInputPayload: vi.fn(async () => false),
        };
      });

      await (controller as any).startPlan({
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        binding: null,
        workspaceDir: "/repo/openclaw",
        prompt: "Ask the breakfast question.",
      });

      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(12_500);

      const sentTexts = sendMessageTelegram.mock.calls.flatMap((call) => {
        const [, text] = call as unknown as [unknown, unknown];
        return typeof text === "string" ? [text] : [];
      });
      expect(sentTexts).toContain(
        "Starting Codex plan mode. I’ll relay the questions and final plan as they arrive.",
      );
      expect((controller as any).store.getPendingRequestById("req-plan-1")).not.toBeNull();
      expect(sentTexts).not.toContain("Codex is still planning...");

      resolveResult?.({
        threadId: "thread-1",
        aborted: true,
      });
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the user to log back in when Codex reports OpenAI auth is required", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    clientMock.readAccount.mockResolvedValue({
      type: "chatgpt",
      requiresOpenaiAuth: true,
    } as any);
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.reject(new Error("codex app server rpc error (-32001): unauthorized")),
      getThreadId: () => undefined,
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    await flushAsyncWork();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      TEST_TELEGRAM_PEER_ID,
      "Codex authentication failed on this machine. Run `codex logout` and `codex login`, then try again.",
      expect.anything(),
    );
    expect(clientMock.readAccount).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: "session-1",
      refreshToken: true,
    });
  });

  it("maps obvious OAuth failures to the same re-login guidance even if account/read also fails", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    clientMock.readAccount.mockRejectedValue(new Error("account probe failed"));
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.reject(new Error("refresh token expired")),
      getThreadId: () => undefined,
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: null,
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    await flushAsyncWork();
    await vi.waitFor(() => {
      expect(sendMessageTelegram).toHaveBeenCalledWith(
        TEST_TELEGRAM_PEER_ID,
        "Codex authentication failed on this machine. Run `codex logout` and `codex login`, then try again.",
        expect.anything(),
      );
    });
  });

  it("surfaces explicit failed turns as auth failures when the terminal error is unauthorized", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        terminalStatus: "failed",
        terminalError: {
          message: "unauthorized",
          codexErrorInfo: "unauthorized",
          httpStatusCode: 401,
        },
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    await flushAsyncWork();
    await vi.waitFor(() => {
      expect(sendMessageTelegram).toHaveBeenCalledWith(
        TEST_TELEGRAM_PEER_ID,
        "Codex authentication failed on this machine. Run `codex logout` and `codex login`, then try again.",
        expect.anything(),
      );
    });
    expect(clientMock.readAccount).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: "session-1",
      refreshToken: true,
    });
  });

  it("passes saved conversation preferences into the next Codex turn", async () => {
    const { controller } = await createControllerHarness();
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "done",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        permissionsMode: "full-access",
        preferences: {
          preferredModel: "gpt-5.4",
          preferredReasoningEffort: "high",
          preferredServiceTier: "fast",
          updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "session-1",
        existingThreadId: "thread-1",
        model: "gpt-5.4",
        reasoningEffort: "high",
        serviceTier: "fast",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    );
  });

  it("passes saved conversation preferences into review runs", async () => {
    const { controller } = await createControllerHarness();
    const startReview = vi.fn(() => ({
      result: new Promise(() => {}),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startReview = startReview;

    await (controller as any).startReview({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        permissionsMode: "full-access",
        preferences: {
          preferredModel: "gpt-5.4",
          preferredReasoningEffort: "high",
          preferredServiceTier: "fast",
          updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      target: { type: "uncommittedChanges" },
      announceStart: false,
    });

    expect(startReview).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "session-1",
        threadId: "thread-1",
        model: "gpt-5.4",
        reasoningEffort: "high",
        serviceTier: "fast",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    );
  });

  it("passes saved conversation preferences into plan runs", async () => {
    const { controller } = await createControllerHarness();
    const startTurn = vi.fn(() => ({
      result: new Promise(() => {}),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    await (controller as any).startPlan({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        permissionsMode: "full-access",
        preferences: {
          preferredModel: "gpt-5.4",
          preferredReasoningEffort: "high",
          preferredServiceTier: "fast",
          updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "plan this",
      announceStart: false,
    });

    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "session-1",
        existingThreadId: "thread-1",
        model: "gpt-5.4",
        reasoningEffort: "high",
        serviceTier: "fast",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-5.4",
            reasoningEffort: "high",
            developerInstructions: null,
          },
        },
      }),
    );
  });

  it("keeps empty completed turns generic instead of inferring an auth failure", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "",
        terminalStatus: "completed",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    await flushAsyncWork();
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      TEST_TELEGRAM_PEER_ID,
      "Codex completed without a text reply.",
      expect.anything(),
    );
    expect(clientMock.readAccount).not.toHaveBeenCalled();
  });

  it("suppresses the empty completion fallback when live assistant text was already delivered", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.startTurn = vi.fn((params: { onAssistantMessage?: (text: string) => Promise<void> }) => {
      queueMicrotask(async () => {
        await params.onAssistantMessage?.("Live summary from Codex.");
      });
      return {
        result: Promise.resolve({
          threadId: "thread-1",
          text: "",
          terminalStatus: "completed",
        }),
        getThreadId: () => "thread-1",
        queueMessage: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      };
    });

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    await flushAsyncWork();
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      TEST_TELEGRAM_PEER_ID,
      "Live summary from Codex.",
      expect.anything(),
    );
    expect(sendMessageTelegram).not.toHaveBeenCalledWith(
      TEST_TELEGRAM_PEER_ID,
      "Codex completed without a text reply.",
      expect.anything(),
    );
  });

  it("refreshes the typing lease on streamed assistant updates and file edit notices", async () => {
    const { controller } = await createControllerHarness();
    const refresh = vi.fn(async () => {});
    const stop = vi.fn();
    (controller as any).startTypingLease = vi.fn(async () => ({
      refresh,
      stop,
    }));
    (controller as any).client.startTurn = vi.fn((params: {
      onAssistantMessage?: (text: string) => Promise<void>;
      onFileEdits?: (text: string) => Promise<void>;
    }) => {
      queueMicrotask(async () => {
        await params.onAssistantMessage?.("Hello");
        await params.onAssistantMessage?.("Hello there");
        await params.onFileEdits?.("Edited 2 files.");
      });
      return {
        result: Promise.resolve({
          threadId: "thread-1",
          text: "Hello there",
          terminalStatus: "completed",
        }),
        getThreadId: () => "thread-1",
        queueMessage: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      };
    });

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    await flushAsyncWork();
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("sends short Discord replies only once at completion when preview streaming never starts", async () => {
    const { controller, sendMessageDiscord } = await createControllerHarness();
    (controller as any).client.startTurn = vi.fn((params: { onAssistantMessage?: (text: string) => Promise<void> }) => {
      queueMicrotask(async () => {
        await params.onAssistantMessage?.("Hello");
        await params.onAssistantMessage?.("Hello there");
      });
      return {
        result: Promise.resolve({
          threadId: "thread-1",
          text: "Hello there",
          terminalStatus: "completed",
        }),
        getThreadId: () => "thread-1",
        queueMessage: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      };
    });

    await (controller as any).startTurn({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      binding: {
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    await flushAsyncWork();
    expect(sendMessageDiscord).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:chan-1",
      "Hello there",
      expect.objectContaining({
        accountId: "default",
      }),
    );
    expect(discordSdkState.editDiscordComponentMessage).not.toHaveBeenCalled();
  });

  it("reuses the Discord preview message as the first final chunk before sending spillover chunks", async () => {
    vi.useFakeTimers();
    try {
      const { controller, sendMessageDiscord, api } = await createControllerHarness();
      const previewText =
        "This is a long Discord preview message that should stream before the turn completes.";
      const finalText = `${previewText} Final spillover chunk.`;
      const firstFinalChunk = "This is a long Discord preview message";
      const spilloverChunk = "that should stream before the turn completes. Final spillover chunk.";

      (api as any).runtime.channel.text.chunkText = vi.fn((text: string) => {
        if (text.length <= firstFinalChunk.length) {
          return [text];
        }
        return [text.slice(0, firstFinalChunk.length), text.slice(firstFinalChunk.length)];
      });

      (controller as any).client.startTurn = vi.fn((params: { onAssistantMessage?: (text: string) => Promise<void> }) => {
        queueMicrotask(async () => {
          await params.onAssistantMessage?.(previewText);
        });
        return {
          result: new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                threadId: "thread-1",
                text: finalText,
                terminalStatus: "completed",
              });
            }, 2_000);
          }),
          getThreadId: () => "thread-1",
          queueMessage: vi.fn(async () => false),
          interrupt: vi.fn(async () => {}),
          isAwaitingInput: () => false,
          submitPendingInput: vi.fn(async () => false),
          submitPendingInputPayload: vi.fn(async () => false),
        };
      });

      const startPromise = (controller as any).startTurn({
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        binding: {
          conversation: {
            channel: "discord",
            accountId: "default",
            conversationId: "channel:chan-1",
          },
          sessionKey: "session-1",
          threadId: "thread-1",
          workspaceDir: "/repo/openclaw",
          updatedAt: Date.now(),
        },
        workspaceDir: "/repo/openclaw",
        prompt: "who are you?",
        reason: "inbound",
      });

      await vi.advanceTimersByTimeAsync(1_200);
      expect(sendMessageDiscord).toHaveBeenCalledTimes(1);
      expect(sendMessageDiscord).toHaveBeenNthCalledWith(
        1,
        "channel:chan-1",
        previewText,
        expect.objectContaining({
          accountId: "default",
        }),
      );

      await vi.advanceTimersByTimeAsync(800);
      vi.useRealTimers();
      await startPromise;
      await flushAsyncWork();

      expect(discordSdkState.editDiscordComponentMessage).toHaveBeenCalledWith(
        "channel:chan-1",
        "discord-msg-1",
        expect.objectContaining({
          text: firstFinalChunk,
        }),
        expect.objectContaining({
          accountId: "default",
        }),
      );
      expect(sendMessageDiscord).toHaveBeenCalledTimes(2);
      expect(sendMessageDiscord).toHaveBeenNthCalledWith(
        2,
        "channel:chan-1",
        spilloverChunk,
        expect.objectContaining({
          accountId: "default",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not probe auth after an approval cancel completes without assistant text", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        stoppedReason: "approval",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    await flushAsyncWork();
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      TEST_TELEGRAM_PEER_ID,
      "Cancelled the Codex approval request.",
      expect.anything(),
    );
    expect(clientMock.readAccount).not.toHaveBeenCalled();
  });

  it("toggles fast mode from the status card and saves preferred service tier", async () => {
    const { controller, clientMock } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "toggle-fast",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(clientMock.setThreadServiceTier).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: "session-1",
      threadId: "thread-1",
      serviceTier: "fast",
    });
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.preferences?.preferredServiceTier).toBe("fast");
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Fast mode: on"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("stores runtime config from Telegram interactive callbacks", async () => {
    const { controller } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "reply-text",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      text: "runtime-config-ok",
    });
    const config = {
      channels: {
        telegram: {
          botToken: "telegram-token-from-callback",
        },
      },
    };

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      config,
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect((controller as any).lastRuntimeConfig).toEqual(config);
  });

  it("warns when the raw Telegram topic rename fallback returns ok false", async () => {
    const { controller, api } = await createControllerHarness();
    const fetchMock = vi.mocked(fetch);
    delete (api as any).runtime.channel.telegram.conversationActions;
    vi.spyOn(controller as any, "loadTelegramRuntimeApi").mockResolvedValue(undefined);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: false,
          description: "Bad Request: not enough rights to manage topics",
        }),
    } as Response);

    await (controller as any).renameConversationIfSupported(
      {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
        threadId: 456,
      },
      "Fresh Thread",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-token/editForumTopic",
      expect.any(Object),
    );
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not enough rights to manage topics"),
    );
  });

  it("uses the Telegram runtime API helper to rename topics when the legacy runtime is unavailable", async () => {
    const { controller, api } = await createControllerHarness();
    delete (api as any).runtime.channel.telegram.conversationActions;
    const renameForumTopicTelegram = vi.fn(async () => ({ ok: true }));
    vi.spyOn(controller as any, "loadTelegramRuntimeApi").mockResolvedValue({
      renameForumTopicTelegram,
    });

    await (controller as any).renameConversationIfSupported(
      {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
        threadId: 456,
      },
      "Fresh Thread",
    );

    expect(renameForumTopicTelegram).toHaveBeenCalledWith(
      "123",
      456,
      "Fresh Thread",
      expect.objectContaining({
        cfg: {},
        accountId: "default",
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the Telegram runtime API helper to edit status card messages when available", async () => {
    const { controller } = await createControllerHarness();
    const editMessageTelegram = vi.fn(async () => ({ ok: true }));
    vi.spyOn(controller as any, "loadTelegramRuntimeApi").mockResolvedValue({
      editMessageTelegram,
    });

    const updated = await (controller as any).updateStatusCardMessage(
      {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      {
        provider: "telegram",
        chatId: "123",
        messageId: "1",
      },
      {
        text: "Binding: Updated",
        buttons: [[{ text: "Refresh", callback_data: "codexapp:refresh" }]],
      },
    );

    expect(updated).toBe(true);
    expect(editMessageTelegram).toHaveBeenCalledWith(
      "123",
      "1",
      "Binding: Updated",
      expect.objectContaining({
        cfg: {},
        accountId: "default",
        buttons: [[expect.objectContaining({ text: "Refresh", callback_data: "codexapp:refresh" })]],
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("toggles fast mode from the status card even when the app server returns stale state", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.setThreadServiceTier.mockImplementation(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    }));
    clientMock.readThreadState.mockImplementation(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    }));
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "toggle-fast",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.preferences?.preferredServiceTier).toBe("fast");
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Fast mode: on"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("stores fast mode as a pending default before the thread is materialized", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.readThreadState.mockRejectedValue(
      new Error(
        "thread thread-1 is not materialized yet; includeTurns is unavailable before first user message",
      ),
    );
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "toggle-fast",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(clientMock.setThreadServiceTier).not.toHaveBeenCalled();
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.preferences?.preferredServiceTier).toBe("fast");
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Fast mode: on"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("turns fast mode off from the status card by clearing the service tier", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.readThreadState.mockImplementation(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "fast",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    }));
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      preferences: {
        preferredServiceTier: "fast",
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "toggle-fast",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(clientMock.setThreadServiceTier).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: "session-1",
      threadId: "thread-1",
      serviceTier: null,
    });
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.preferences?.preferredServiceTier).toBe("default");
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Fast mode: off"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("cycles permissions mode between default and full-access profiles", async () => {
    const { controller, clientMock } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      permissionsMode: "default",
      updatedAt: Date.now(),
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    const first = await (controller as any).store.putCallback({
      kind: "toggle-permissions",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: first.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    let binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(clientMock.setThreadPermissions).toHaveBeenNthCalledWith(1, {
      profile: "full-access",
      sessionKey: "session-1",
      threadId: "thread-1",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Permissions: Full Access"),
      }),
    );

    const second = await (controller as any).store.putCallback({
      kind: "toggle-permissions",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: second.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("default");
    expect(clientMock.setThreadPermissions).toHaveBeenNthCalledWith(2, {
      profile: "default",
      sessionKey: "session-1",
      threadId: "thread-1",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Permissions: Default"),
      }),
    );
  });

  it("stores permissions mode as a pending default before the thread is materialized", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.readThreadState.mockRejectedValue(
      new Error(
        "thread thread-1 is not materialized yet; includeTurns is unavailable before first user message",
      ),
    );
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      permissionsMode: "default",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "toggle-permissions",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(clientMock.setThreadPermissions).not.toHaveBeenCalled();
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(binding?.pendingPermissionsMode).toBeUndefined();
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Permissions: Full Access"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("defers permission profile migration until the active run ends", async () => {
    const { controller, clientMock } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      permissionsMode: "default",
      updatedAt: Date.now(),
    });
    const interrupt = vi.fn(async () => {
      (controller as any).activeRuns.delete("telegram::default::123::");
    });
    (controller as any).activeRuns.set("telegram::default::123::", {
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      profile: "full-access",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "done" }),
        queueMessage: vi.fn(async () => false),
        getThreadId: () => "thread-1",
        interrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });
    const callback = await (controller as any).store.putCallback({
      kind: "toggle-permissions",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("default");
    expect(binding?.pendingPermissionsMode).toBe("full-access");
    expect(clientMock.setThreadPermissions).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Permissions note: Full Access will apply after the current Codex turn ends."),
        buttons: expect.any(Array),
      }),
    );
  });

  it("stops the active run from the status card", async () => {
    const { controller, clientMock } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "stop-run",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});
    const interrupt = vi.fn(async () => {
      (controller as any).activeRuns.delete("telegram::default::123::");
    });
    (controller as any).activeRuns.set("telegram::default::123::", {
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      profile: "full-access",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "done" }),
        queueMessage: vi.fn(async () => false),
        getThreadId: () => "thread-1",
        interrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(interrupt).toHaveBeenCalledOnce();
    expect((controller as any).activeRuns.has("telegram::default::123::")).toBe(false);
    expect(clientMock.readThreadState).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: "session-1",
      threadId: "thread-1",
    });
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Binding: Discord Thread (openclaw)"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("keeps default permissions and explains when Full Access is unavailable", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.hasProfile.mockImplementation((profile: string) => profile === "default");
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      permissionsMode: "default",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "toggle-permissions",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("default");
    expect(clientMock.setThreadPermissions).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Permissions: Default"),
        buttons: expect.any(Array),
      }),
    );
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "Permissions note: Full Access is unavailable in the current Codex Desktop session",
        ),
      }),
    );
  });

  it("shows model-picker buttons in place from the status card callback", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "show-model-picker",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token, messageId: 41, chatId: "123" },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(sendMessageTelegram).not.toHaveBeenCalled();
    const lastCall = editMessage.mock.calls.at(-1)?.[0] as
      | { text?: string; buttons?: Array<Array<{ text: string; callback_data: string }>> }
      | undefined;
    expect(lastCall?.text).toContain("Binding:");
    expect(Array.isArray(lastCall?.buttons)).toBe(true);
    expect(lastCall?.buttons?.some((row) => row[0]?.text === "Cancel")).toBe(true);
    const firstToken = String(lastCall?.buttons?.[0]?.[0]?.callback_data ?? "").split(":").pop() ?? "";
    expect((controller as any).store.getCallback(firstToken)).toEqual(
      expect.objectContaining({
        kind: "set-model",
        returnToStatus: true,
      }),
    );
    const cancelToken = String(
      lastCall?.buttons
        ?.flat()
        .find((button) => button.text === "Cancel")
        ?.callback_data ?? "",
    ).split(":").pop();
    expect((controller as any).store.getCallback(cancelToken)).toEqual(
      expect.objectContaining({
        kind: "refresh-status",
      }),
    );
  });

  it("shows reasoning-picker buttons from the status card callback", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "show-reasoning-picker",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token, messageId: 41, chatId: "123" },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const lastCall = editMessage.mock.calls.at(-1)?.[0] as any;
    expect(lastCall?.text).toContain("Binding:");
    expect(lastCall?.buttons?.some((row: Array<{ text: string }>) => row[0]?.text === "High")).toBe(true);
    expect(lastCall?.buttons?.some((row: Array<{ text: string }>) => row[0]?.text === "Cancel")).toBe(true);
    const cancelToken = String(
      lastCall?.buttons
        ?.flat()
        .find((button: { text: string }) => button.text === "Cancel")
        ?.callback_data ?? "",
    )
      .split(":")
      .pop();
    expect((controller as any).store.getCallback(cancelToken)).toEqual(
      expect.objectContaining({
        kind: "refresh-status",
      }),
    );
  });

  it("shows reasoning-picker buttons for an unmaterialized thread using the current default model", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.readThreadState.mockRejectedValue(
      new Error(
        "thread thread-1 is not materialized yet; includeTurns is unavailable before first user message",
      ),
    );
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "show-reasoning-picker",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token, messageId: 41, chatId: "123" },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const lastCall = editMessage.mock.calls.at(-1)?.[0] as any;
    expect(lastCall?.text).toContain("Binding:");
    expect(lastCall?.text).toContain("saved as defaults until then");
    expect(lastCall?.buttons?.some((row: Array<{ text: string }>) => row[0]?.text === "High")).toBe(true);
    expect(lastCall?.buttons?.some((row: Array<{ text: string }>) => row[0]?.text === "Cancel")).toBe(true);
  });

  it("shows the model picker in a separate message using the saved preferred model when the thread snapshot is stale", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    clientMock.readThreadState.mockImplementation(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    }));
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      preferences: {
        preferredModel: "openai/gpt-5.3",
        preferredServiceTier: null,
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "show-model-picker",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(editMessage).not.toHaveBeenCalled();
    const pickerCall = sendMessageTelegram.mock.calls.at(-1) as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string }>> }]
      | undefined;
    expect(pickerCall?.[0]).toBe("123");
    expect(pickerCall?.[1]).toContain("Current model: openai/gpt-5.3");
    expect(pickerCall?.[2]?.buttons?.some((row) => row[0]?.text === "openai/gpt-5.3 (current)")).toBe(true);
  });

  it("sets the model from the status picker and returns to the updated status card", async () => {
    const { controller, clientMock } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "set-model",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      model: "openai/gpt-5.3",
      returnToStatus: true,
    });
    const reply = vi.fn(async () => {});
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply,
        editMessage,
      },
    } as any);

    expect(clientMock.setThreadModel).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: "session-1",
      threadId: "thread-1",
      model: "openai/gpt-5.3",
    });
    expect(reply).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Model: openai/gpt-5.3"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("sets the reasoning from the status picker and returns to the updated status card", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "set-reasoning",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      reasoningEffort: "high",
      returnToStatus: true,
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.preferences?.preferredReasoningEffort).toBe("high");
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Model: openai/gpt-5.4 · reasoning high"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("starts compaction from the status card", async () => {
    const { controller } = await createControllerHarness();
    const startCompact = vi.fn(async () => {});
    (controller as any).startCompact = startCompact;
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "compact-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(startCompact).toHaveBeenCalledWith({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
        threadId: undefined,
      },
      binding: expect.objectContaining({
        sessionKey: "session-1",
        threadId: "thread-1",
      }),
    });
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Compaction started."),
        buttons: expect.any(Array),
      }),
    );
  });

  it("runs skills from the status card without rewriting the status message", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "show-skills",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(editMessage).not.toHaveBeenCalled();
    const pickerCall = sendMessageTelegram.mock.calls.at(-1) as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string }>> }]
      | undefined;
    expect(pickerCall?.[0]).toBe("123");
    expect(pickerCall?.[1]).toContain("Type `$skill-name` in this chat to run one directly.");
    expect(pickerCall?.[2]?.buttons?.flat().map((button) => button.text)).toEqual(
      expect.arrayContaining(["$skill-a", "$skill-b", "Mode: toggle", "Cancel"]),
    );
  });

  it("toggles skills picker into help mode and prints help without rewriting the picker", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    const helpView = await (controller as any).store.putCallback({
      kind: "picker-view",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      view: {
        mode: "skills",
        page: 0,
        clickMode: "help",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: helpView.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Mode: Click to Print Help. Page 1/1."),
        buttons: expect.any(Array),
      }),
    );
    const helpCallback = await (controller as any).store.putCallback({
      kind: "show-skill-help",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      skillName: "skill-a",
      description: "Skill A",
      cwd: "/repo/openclaw",
      enabled: true,
    });

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: helpCallback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Skill: $skill-a"),
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("runs MCPs from the status card without rewriting the status message", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "show-mcp",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(editMessage).not.toHaveBeenCalled();
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("No MCP servers reported."),
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("sets the model from the status picker using the requested model when the app server returns stale state", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.setThreadModel.mockImplementation(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    }));
    clientMock.readThreadState.mockImplementation(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    }));
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "set-model",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      model: "openai/gpt-5.3",
      returnToStatus: true,
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.preferences?.preferredModel).toBe("openai/gpt-5.3");
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Model: openai/gpt-5.3"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("stores the selected model as a pending default before the thread is materialized", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.readThreadState.mockRejectedValue(
      new Error(
        "thread thread-1 is not materialized yet; includeTurns is unavailable before first user message",
      ),
    );
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "set-model",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      model: "openai/gpt-5.3",
      returnToStatus: true,
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(clientMock.setThreadModel).not.toHaveBeenCalled();
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.preferences?.preferredModel).toBe("openai/gpt-5.3");
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Model: openai/gpt-5.3"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("clears fast mode when switching to a model that does not support it", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.setThreadModel.mockImplementation(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "fast",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    }));
    clientMock.readThreadState.mockImplementation(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    }));
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      preferences: {
        preferredModel: "openai/gpt-5.4",
        preferredServiceTier: "fast",
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "set-model",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      model: "gpt-5.3-codex-spark",
      returnToStatus: true,
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(clientMock.setThreadServiceTier).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: "session-1",
      threadId: "thread-1",
      serviceTier: null,
    });
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.preferences?.preferredModel).toBe("gpt-5.3-codex-spark");
    expect(binding?.preferences?.preferredServiceTier).toBe("default");
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Model: gpt-5.3-codex-spark"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("dismisses the picker when cancel-picker callback is pressed", async () => {
    const { controller } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "cancel-picker",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
    });
    const acknowledge = vi.fn(async () => {});
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge,
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage,
        clearComponents: vi.fn(async () => {}),
      },
    } as any);

    // editPicker uses ctx.respond.editMessage first; when that succeeds it calls
    // registerBuiltDiscordComponentMessage instead of editDiscordComponentMessage
    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(discordSdkState.registerBuiltDiscordComponentMessage).toHaveBeenCalledWith({
      buildResult: expect.objectContaining({
        components: expect.any(Array),
        entries: expect.any(Array),
      }),
      messageId: "message-1",
    });
    // The callback should be removed from the store
    expect((controller as any).store.getCallback(callback.token)).toBeNull();
  });
});
