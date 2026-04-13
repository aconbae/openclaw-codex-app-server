import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, PluginInteractiveButtons } from "./openclaw-types.js";
import {
  OpenClawChannelMessageDelivery,
  type ProviderOutboundAdapter,
} from "./channel-message-delivery.js";

function createApiMock(runtimeChannel?: Record<string, unknown>): OpenClawPluginApi {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    runtime: {
      channel: {
        text: {
          chunkText: (text: string) => [text],
          resolveTextChunkLimit: (
            _cfg: unknown,
            _provider?: string,
            _accountId?: string | null,
            opts?: { fallbackLimit?: number },
          ) => opts?.fallbackLimit ?? 2000,
        },
        ...(runtimeChannel ?? {}),
      },
    },
  } as unknown as OpenClawPluginApi;
}

function createDeliveryHarness(options?: {
  api?: OpenClawPluginApi;
  config?: Record<string, unknown>;
  loadTelegramOutboundAdapter?: () => Promise<ProviderOutboundAdapter | undefined>;
  loadDiscordOutboundAdapter?: () => Promise<ProviderOutboundAdapter | undefined>;
  loadTelegramRuntimeApi?: () => Promise<Record<string, unknown> | undefined>;
  loadDiscordRuntimeApi?: () => Promise<Record<string, unknown> | undefined>;
  resolveTelegramBotToken?: (accountId?: string) => Promise<string | undefined>;
  resolveDiscordBotToken?: (accountId?: string) => Promise<string | undefined>;
  resolveReplyMediaLocalRoots?: (mediaUrl?: string) => readonly string[] | undefined;
}) {
  const api = options?.api ?? createApiMock();
  const loadTelegramOutboundAdapter =
    options?.loadTelegramOutboundAdapter ?? vi.fn(async () => undefined);
  const loadDiscordOutboundAdapter =
    options?.loadDiscordOutboundAdapter ?? vi.fn(async () => undefined);
  const loadTelegramRuntimeApi =
    options?.loadTelegramRuntimeApi ?? vi.fn(async () => undefined);
  const loadDiscordRuntimeApi =
    options?.loadDiscordRuntimeApi ?? vi.fn(async () => undefined);
  const resolveTelegramBotToken =
    options?.resolveTelegramBotToken ?? vi.fn(async () => undefined);
  const resolveDiscordBotToken =
    options?.resolveDiscordBotToken ?? vi.fn(async () => undefined);
  const resolveReplyMediaLocalRoots =
    options?.resolveReplyMediaLocalRoots ?? vi.fn(() => undefined);
  const buildDiscordPickerSpec = vi.fn((picker: { text: string; buttons: PluginInteractiveButtons | undefined }) => ({
    text: picker.text,
    blocks: (picker.buttons ?? []).map((row) => ({
      type: "actions" as const,
      buttons: row.map((button) => ({
        label: button.text,
        style: "primary" as const,
        callbackData: button.callback_data,
      })),
    })),
  }));
  const sendDiscordPickerMessageLegacy = vi.fn(async () => null);
  const delivery = new OpenClawChannelMessageDelivery({
    api,
    getConfig: () => options?.config as any,
    loadTelegramOutboundAdapter,
    loadDiscordOutboundAdapter,
    loadTelegramRuntimeApi: loadTelegramRuntimeApi as any,
    loadDiscordRuntimeApi: loadDiscordRuntimeApi as any,
    resolveTelegramBotToken,
    resolveDiscordBotToken,
    resolveReplyMediaLocalRoots,
    formatConversationForLog: (conversation) =>
      `${conversation.channel}:${conversation.accountId}:${conversation.conversationId}`,
    denormalizeDiscordConversationId: (raw) =>
      raw?.startsWith("channel:") ? raw.slice("channel:".length) : raw,
    buildDiscordPickerSpec,
    sendDiscordPickerMessageLegacy,
  });
  return {
    api,
    delivery,
    loadTelegramOutboundAdapter,
    loadDiscordOutboundAdapter,
    loadTelegramRuntimeApi,
    loadDiscordRuntimeApi,
    resolveTelegramBotToken,
    resolveDiscordBotToken,
    resolveReplyMediaLocalRoots,
    buildDiscordPickerSpec,
    sendDiscordPickerMessageLegacy,
  };
}

describe("OpenClawChannelMessageDelivery", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("skips the Telegram outbound adapter when runtime config is unavailable", async () => {
    const sendMessageTelegram = vi.fn(async () => ({ messageId: "1", chatId: "123" }));
    const api = createApiMock({
      telegram: {
        sendMessageTelegram,
      },
    });
    const sendPayload = vi.fn(async () => ({ messageId: "ignored", chatId: "ignored" }));
    const { delivery } = createDeliveryHarness({
      api,
      config: undefined,
      loadTelegramOutboundAdapter: async () => ({
        sendPayload,
      } as unknown as ProviderOutboundAdapter),
    });

    await delivery.sendTelegramTextChunk(
      {
        sendPayload,
      } as unknown as ProviderOutboundAdapter,
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

    expect(sendPayload).not.toHaveBeenCalled();
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "Hello from fallback",
      expect.objectContaining({
        accountId: "default",
        buttons: expect.any(Array),
      }),
    );
  });

  it("uses the Telegram runtime API helper to edit messages when available", async () => {
    const editMessageTelegram = vi.fn(async () => ({ ok: true }));
    const fetchMock = vi.mocked(fetch);
    const { delivery } = createDeliveryHarness({
      config: {},
      loadTelegramRuntimeApi: async () => ({
        editMessageTelegram,
      }),
    });

    await delivery.editTelegramMessage("123", "1", "Binding: Updated", {
      accountId: "default",
      buttons: [[{ text: "Refresh", callback_data: "codexapp:refresh" }]],
    });

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
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the Discord pin REST API when no runtime helper is available", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      text: async () => "",
    } as Response);
    const resolveDiscordBotToken = vi.fn(async () => "discord-token");
    const { delivery, resolveDiscordBotToken: resolveDiscordBotTokenMock } = createDeliveryHarness({
      loadDiscordRuntimeApi: async () => undefined,
      resolveDiscordBotToken,
    });

    await delivery.pinDiscordMessage("channel-1", "message-1", {
      accountId: "default",
    });

    expect(resolveDiscordBotTokenMock).toHaveBeenCalledWith("default");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/channel-1/pins/message-1",
      expect.objectContaining({
        method: "PUT",
        headers: {
          Authorization: "Bot discord-token",
        },
      }),
    );
  });

  it("warns when the raw Telegram topic rename fallback returns ok false", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: false,
          description: "Bad Request: not enough rights to manage topics",
        }),
    } as Response);
    const { delivery, api } = createDeliveryHarness({
      api: createApiMock(),
      config: {},
      loadTelegramRuntimeApi: async () => undefined,
      resolveTelegramBotToken: async () => "telegram-token",
    });

    await delivery.renameConversationIfSupported(
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

  it("sends the final Discord chunk as a component payload when buttons are present", async () => {
    const sendText = vi.fn(async () => ({ messageId: "discord-msg-1", channelId: "channel:chan-1" }));
    const sendPayload = vi.fn(async () => ({ messageId: "discord-msg-2", channelId: "channel:chan-1" }));
    const api = createApiMock({
      text: {
        chunkText: (text: string) => ["Chunk A", "Chunk B"],
        resolveTextChunkLimit: () => 2000,
      },
    });
    const { delivery, buildDiscordPickerSpec } = createDeliveryHarness({
      api,
      config: {},
      loadDiscordOutboundAdapter: async () =>
        ({
          sendText,
          sendPayload,
        }) as unknown as ProviderOutboundAdapter,
    });

    const delivered = await delivery.sendReplyWithDeliveryRef(
      {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      {
        text: "Chunk A\n\nChunk B",
        buttons: [[{ text: "Pick", callback_data: "codexapp:pick" }]],
      },
    );

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "channel:chan-1",
        text: "Chunk A",
      }),
    );
    expect(buildDiscordPickerSpec).toHaveBeenCalledWith({
      text: "Chunk B",
      buttons: [[{ text: "Pick", callback_data: "codexapp:pick" }]],
    });
    expect(sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "channel:chan-1",
        payload: expect.objectContaining({
          text: "Chunk B",
        }),
      }),
    );
    expect(delivered).toEqual({
      provider: "discord",
      messageId: "discord-msg-2",
      channelId: "channel:chan-1",
    });
  });
});
