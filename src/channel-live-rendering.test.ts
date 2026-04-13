import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DiscordComponentBuildResult,
  DiscordComponentMessageSpec,
} from "./discord-component-types.js";
import {
  OpenClawChannelLiveRendering,
  type StatusCardRender,
} from "./channel-live-rendering.js";
import type { OpenClawPluginApi, PluginInteractiveButtons } from "./openclaw-types.js";
import type { ConversationTarget, InteractiveMessageRef } from "./types.js";

function createApiMock(options?: {
  chunkText?: (text: string, limit: number) => string[];
  resolveTextChunkLimit?: (
    cfg: unknown,
    provider?: string,
    accountId?: string | null,
    opts?: { fallbackLimit?: number },
  ) => number;
}): OpenClawPluginApi {
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
          chunkText: options?.chunkText ?? ((text: string) => [text]),
          resolveTextChunkLimit:
            options?.resolveTextChunkLimit ??
            ((_cfg: unknown, _provider?: string, _accountId?: string | null, opts?: { fallbackLimit?: number }) =>
              opts?.fallbackLimit ?? 2000),
        },
      },
    },
  } as unknown as OpenClawPluginApi;
}

function createBuildResult(text: string): DiscordComponentBuildResult {
  return {
    components: [text],
    entries: [{ id: "entry-1", kind: "button", label: "Tap" }],
    modals: [],
  };
}

function createRenderingHarness(options?: {
  api?: OpenClawPluginApi;
  editTelegramMessage?: (
    chatId: string,
    messageId: string,
    text: string,
    opts?: { accountId?: string; buttons?: PluginInteractiveButtons },
  ) => Promise<void>;
  editDiscordComponentMessage?: (
    to: string,
    messageId: string,
    spec: DiscordComponentMessageSpec,
    opts?: { accountId?: string },
  ) => Promise<{ messageId: string; channelId: string }>;
  registerBuiltDiscordComponentMessage?: (params: {
    buildResult: DiscordComponentBuildResult;
    messageId: string;
  }) => Promise<void>;
  buildDiscordPickerSpec?: (picker: { text: string; buttons: PluginInteractiveButtons | undefined }) => DiscordComponentMessageSpec;
  buildDiscordPickerMessage?: (picker: { text: string; buttons: PluginInteractiveButtons | undefined }) => Promise<DiscordComponentBuildResult>;
  buildDiscordTextMessage?: (params: {
    text: string;
    accountId?: string;
  }) => Promise<DiscordComponentBuildResult>;
  sendTextWithDeliveryRef?: (
    conversation: ConversationTarget,
    text: string,
  ) => Promise<InteractiveMessageRef | null>;
  sendSingleTextWithDeliveryRef?: (
    conversation: ConversationTarget,
    text: string,
  ) => Promise<InteractiveMessageRef | null>;
}) {
  const api = options?.api ?? createApiMock();
  const editTelegramMessage =
    options?.editTelegramMessage ?? vi.fn(async () => {});
  const editDiscordComponentMessage =
    options?.editDiscordComponentMessage ??
    vi.fn(async () => ({ messageId: "discord-message-1", channelId: "channel:chan-1" }));
  const registerBuiltDiscordComponentMessage =
    options?.registerBuiltDiscordComponentMessage ?? vi.fn(async () => {});
  const buildDiscordPickerSpec =
    options?.buildDiscordPickerSpec ??
    vi.fn((picker: { text: string; buttons: PluginInteractiveButtons | undefined }) => ({
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
  const buildDiscordPickerMessage =
    options?.buildDiscordPickerMessage ??
    vi.fn(async (picker: { text: string; buttons: PluginInteractiveButtons | undefined }) =>
      createBuildResult(picker.text),
    );
  const buildDiscordTextMessage =
    options?.buildDiscordTextMessage ??
    vi.fn(async (params: { text: string; accountId?: string }) => createBuildResult(params.text));
  const sendTextWithDeliveryRef =
    options?.sendTextWithDeliveryRef ?? vi.fn(async () => null);
  const sendSingleTextWithDeliveryRef =
    options?.sendSingleTextWithDeliveryRef ?? vi.fn(async () => null);
  const rendering = new OpenClawChannelLiveRendering({
    api,
    formatConversationForLog: (conversation) =>
      `${conversation.channel}:${conversation.accountId}:${conversation.conversationId}`,
    editTelegramMessage,
    editDiscordComponentMessage,
    registerBuiltDiscordComponentMessage,
    buildDiscordPickerSpec,
    buildDiscordPickerMessage,
    buildDiscordTextMessage,
    sendTextWithDeliveryRef,
    sendSingleTextWithDeliveryRef,
  });
  return {
    api,
    rendering,
    editTelegramMessage,
    editDiscordComponentMessage,
    registerBuiltDiscordComponentMessage,
    buildDiscordPickerSpec,
    buildDiscordPickerMessage,
    buildDiscordTextMessage,
    sendTextWithDeliveryRef,
    sendSingleTextWithDeliveryRef,
  };
}

describe("OpenClawChannelLiveRendering", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("updates Telegram status cards through the Telegram edit helper", async () => {
    const { rendering, editTelegramMessage } = createRenderingHarness();
    const updated = await rendering.updateStatusCardMessage(
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
      } satisfies StatusCardRender,
    );

    expect(updated).toBe(true);
    expect(editTelegramMessage).toHaveBeenCalledWith(
      "123",
      "1",
      "Binding: Updated",
      expect.objectContaining({
        accountId: "default",
        buttons: [[expect.objectContaining({ text: "Refresh", callback_data: "codexapp:refresh" })]],
      }),
    );
  });

  it("grows chunked Telegram live replies by editing existing chunks and appending new ones", async () => {
    const api = createApiMock({
      chunkText: (text: string) => {
        if (text === "Alpha Beta") {
          return ["Alpha", "Beta"];
        }
        if (text === "Alpha Gamma Delta") {
          return ["Alpha", "Gamma", "Delta"];
        }
        return [text];
      },
    });
    const sendTextWithDeliveryRef = vi
      .fn()
      .mockResolvedValueOnce({
        provider: "telegram",
        chatId: "123",
        messageId: "1",
      })
      .mockResolvedValueOnce({
        provider: "telegram",
        chatId: "123",
        messageId: "2",
      })
      .mockResolvedValueOnce({
        provider: "telegram",
        chatId: "123",
        messageId: "3",
      });
    const { rendering, editTelegramMessage } = createRenderingHarness({
      api,
      sendTextWithDeliveryRef,
    });
    const writer = rendering.createLiveAssistantReplyWriter({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });

    await writer.update("Alpha Beta");
    await writer.finalize("Alpha Gamma Delta");

    expect(sendTextWithDeliveryRef).toHaveBeenCalledTimes(3);
    expect(sendTextWithDeliveryRef).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: "telegram",
        conversationId: "123",
      }),
      "Alpha",
    );
    expect(sendTextWithDeliveryRef).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: "telegram",
        conversationId: "123",
      }),
      "Beta",
    );
    expect(sendTextWithDeliveryRef).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        channel: "telegram",
        conversationId: "123",
      }),
      "Delta",
    );
    expect(editTelegramMessage).toHaveBeenCalledWith(
      "123",
      "2",
      "Gamma",
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("sends short Discord replies only once at completion when preview streaming never starts", async () => {
    const sendTextWithDeliveryRef = vi.fn(async () => ({
      provider: "discord" as const,
      channelId: "channel:chan-1",
      messageId: "discord-msg-1",
    }));
    const { rendering, editDiscordComponentMessage, sendSingleTextWithDeliveryRef } =
      createRenderingHarness({
        sendTextWithDeliveryRef,
      });
    const writer = rendering.createLiveAssistantReplyWriter({
      channel: "discord",
      accountId: "default",
      conversationId: "channel:chan-1",
    });

    await writer.update("Hello");
    await writer.update("Hello there");
    const delivered = await writer.finalize("Hello there");

    expect(delivered).toBe(false);
    expect(sendTextWithDeliveryRef).not.toHaveBeenCalled();
    expect(sendSingleTextWithDeliveryRef).not.toHaveBeenCalled();
    expect(editDiscordComponentMessage).not.toHaveBeenCalled();
  });

  it("reuses the Discord preview message as the first final chunk before sending spillover chunks", async () => {
    vi.useFakeTimers();
    const previewText =
      "This is a long Discord preview message that should stream before the turn completes.";
    const finalText = `${previewText} Final spillover chunk.`;
    const firstFinalChunk = "This is a long Discord preview message";
    const spilloverChunk = "that should stream before the turn completes. Final spillover chunk.";
    const api = createApiMock({
      chunkText: (text: string) => {
        if (text.length <= firstFinalChunk.length) {
          return [text];
        }
        return [text.slice(0, firstFinalChunk.length), text.slice(firstFinalChunk.length)];
      },
    });
    const sendSingleTextWithDeliveryRef = vi
      .fn()
      .mockResolvedValueOnce({
        provider: "discord",
        channelId: "channel:chan-1",
        messageId: "discord-msg-1",
      })
      .mockResolvedValueOnce({
        provider: "discord",
        channelId: "channel:chan-1",
        messageId: "discord-msg-2",
      });
    const { rendering, editDiscordComponentMessage } = createRenderingHarness({
      api,
      sendSingleTextWithDeliveryRef,
    });
    const writer = rendering.createLiveAssistantReplyWriter({
      channel: "discord",
      accountId: "default",
      conversationId: "channel:chan-1",
    });

    await writer.update(previewText);
    await vi.advanceTimersByTimeAsync(1_200);
    await Promise.resolve();

    const delivered = await writer.finalize(finalText);

    expect(delivered).toBe(true);
    expect(sendSingleTextWithDeliveryRef).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: "discord",
        conversationId: "channel:chan-1",
      }),
      previewText,
    );
    expect(editDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      "discord-msg-1",
      expect.objectContaining({
        text: firstFinalChunk,
      }),
      expect.objectContaining({
        accountId: "default",
      }),
    );
    expect(sendSingleTextWithDeliveryRef).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: "discord",
        conversationId: "channel:chan-1",
      }),
      ` ${spilloverChunk}`,
    );
  });
});
