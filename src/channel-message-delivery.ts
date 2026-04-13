import type { OpenClawConfig as HostOpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/core";
import type { DiscordComponentMessageSpec } from "./discord-component-types.js";
import type { OpenClawPluginApi, PluginInteractiveButtons } from "./openclaw-types.js";
import type { ConversationTarget, InteractiveMessageRef } from "./types.js";
import {
  getLegacyDiscordRuntime,
  getLegacyTelegramRuntime,
  type DiscordComponentMessageSendResult,
  type DiscordRuntimeApiModule,
  type TelegramRuntimeApiModule,
} from "./channel-runtime-adapters.js";

export type ProviderOutboundAdapter = Pick<
  ChannelOutboundAdapter,
  "sendMedia" | "sendPayload" | "sendText"
>;

type DeliveredMessageRef = InteractiveMessageRef;

type DiscordPickerRender = {
  text: string;
  buttons: PluginInteractiveButtons | undefined;
};

export type OpenClawChannelMessageDeliveryParams = {
  api: OpenClawPluginApi;
  getConfig: () => HostOpenClawConfig | undefined;
  loadTelegramOutboundAdapter: () => Promise<ProviderOutboundAdapter | undefined>;
  loadDiscordOutboundAdapter: () => Promise<ProviderOutboundAdapter | undefined>;
  loadTelegramRuntimeApi: () => Promise<TelegramRuntimeApiModule | undefined>;
  loadDiscordRuntimeApi: () => Promise<DiscordRuntimeApiModule | undefined>;
  resolveTelegramBotToken: (accountId?: string) => Promise<string | undefined>;
  resolveDiscordBotToken: (accountId?: string) => Promise<string | undefined>;
  resolveReplyMediaLocalRoots: (mediaUrl?: string) => readonly string[] | undefined;
  formatConversationForLog: (conversation: ConversationTarget) => string;
  denormalizeDiscordConversationId: (raw: string | undefined) => string | undefined;
  buildDiscordPickerSpec: (picker: DiscordPickerRender) => DiscordComponentMessageSpec;
  sendDiscordPickerMessageLegacy: (
    conversation: ConversationTarget,
    picker: DiscordPickerRender,
  ) => Promise<DiscordComponentMessageSendResult | null>;
};

function isTelegramChannel(channel: string): boolean {
  return channel.trim().toLowerCase() === "telegram";
}

function isDiscordChannel(channel: string): boolean {
  return channel.trim().toLowerCase() === "discord";
}

function summarizeTextForLog(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "<empty>";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function buildTelegramReplyMarkup(
  buttons?: PluginInteractiveButtons,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined {
  if (!buttons || buttons.length === 0) {
    return undefined;
  }
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((button) => ({
        text: button.text,
        callback_data: button.callback_data,
      })),
    ),
  };
}

function buildTelegramDeliveredRef(
  conversation: ConversationTarget,
  result: { messageId: string; chatId?: string },
): DeliveredMessageRef {
  return {
    provider: "telegram",
    messageId: result.messageId,
    chatId:
      typeof result.chatId === "string"
        ? result.chatId
        : conversation.parentConversationId ?? conversation.conversationId,
  };
}

function buildDiscordDeliveredRef(
  conversation: ConversationTarget,
  result: { messageId: string; channelId?: string },
): DeliveredMessageRef {
  return {
    provider: "discord",
    messageId: result.messageId,
    channelId:
      typeof result.channelId === "string"
        ? result.channelId
        : conversation.conversationId,
  };
}

export class OpenClawChannelMessageDelivery {
  constructor(private readonly params: OpenClawChannelMessageDeliveryParams) {}

  async sendReplyWithDeliveryRef(
    conversation: ConversationTarget,
    payload: {
      text?: string;
      buttons?: PluginInteractiveButtons;
      mediaUrl?: string;
    },
  ): Promise<DeliveredMessageRef | null> {
    const text = payload.text?.trim() ?? "";
    const hasMedia = typeof payload.mediaUrl === "string" && payload.mediaUrl.trim().length > 0;
    if (!text && !hasMedia) {
      return null;
    }
    this.params.api.logger.debug?.(
      `codex outbound send start ${this.params.formatConversationForLog(conversation)} textChars=${text.length} media=${hasMedia ? "yes" : "no"} buttons=${payload.buttons?.length ?? 0} preview="${summarizeTextForLog(text, 80)}"`,
    );
    if (isTelegramChannel(conversation.channel)) {
      const outbound = await this.params.loadTelegramOutboundAdapter();
      const outboundCfg = this.params.getConfig();
      const mediaLocalRoots = this.params.resolveReplyMediaLocalRoots(payload.mediaUrl);
      const limit = this.params.api.runtime.channel.text.resolveTextChunkLimit(
        undefined,
        "telegram",
        conversation.accountId,
        { fallbackLimit: 4000 },
      );
      const chunks = text
        ? this.params.api.runtime.channel.text.chunkText(text, limit).filter(Boolean)
        : [];
      let delivered: DeliveredMessageRef | null = null;
      if (hasMedia) {
        const result =
          chunks.length <= 1 && payload.buttons && outboundCfg && outbound?.sendPayload
            ? await outbound.sendPayload({
                cfg: outboundCfg,
                to: conversation.parentConversationId ?? conversation.conversationId,
                accountId: conversation.accountId,
                threadId: conversation.threadId,
                mediaLocalRoots,
                text: chunks[0] ?? text,
                payload: {
                  text: chunks[0] ?? text,
                  mediaUrl: payload.mediaUrl,
                  channelData: {
                    telegram: {
                      buttons: payload.buttons,
                    },
                  },
                },
              })
            : await this.sendTelegramMediaChunk(outbound, conversation, chunks[0] ?? text, {
                mediaUrl: payload.mediaUrl,
                mediaLocalRoots,
                buttons: chunks.length <= 1 ? payload.buttons : undefined,
              });
        delivered = buildTelegramDeliveredRef(conversation, result);
        for (let index = 1; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          if (!chunk) {
            continue;
          }
          const result =
            index === chunks.length - 1 && payload.buttons && outboundCfg && outbound?.sendPayload
              ? await outbound.sendPayload({
                  cfg: outboundCfg,
                  to: conversation.parentConversationId ?? conversation.conversationId,
                  accountId: conversation.accountId,
                  threadId: conversation.threadId,
                  text: chunk,
                  payload: {
                    text: chunk,
                    channelData: {
                      telegram: {
                        buttons: payload.buttons,
                      },
                    },
                  },
                })
              : await this.sendTelegramTextChunk(outbound, conversation, chunk, {
                  buttons: index === chunks.length - 1 ? payload.buttons : undefined,
                });
          if (index === chunks.length - 1 || !delivered) {
            delivered = buildTelegramDeliveredRef(conversation, result);
          }
        }
        this.params.api.logger.debug?.(
          `codex outbound send complete ${this.params.formatConversationForLog(conversation)} channel=telegram chunks=${Math.max(chunks.length, 1)} media=${hasMedia ? "yes" : "no"}`,
        );
        return delivered;
      }
      const textChunks = chunks.length > 0 ? chunks : [text];
      for (let index = 0; index < textChunks.length; index += 1) {
        const chunk = textChunks[index];
        if (!chunk) {
          continue;
        }
        const result =
          index === textChunks.length - 1 && payload.buttons && outboundCfg && outbound?.sendPayload
            ? await outbound.sendPayload({
                cfg: outboundCfg,
                to: conversation.parentConversationId ?? conversation.conversationId,
                accountId: conversation.accountId,
                threadId: conversation.threadId,
                text: chunk,
                payload: {
                  text: chunk,
                  channelData: {
                    telegram: {
                      buttons: payload.buttons,
                    },
                  },
                },
              })
            : await this.sendTelegramTextChunk(outbound, conversation, chunk, {
                buttons: index === textChunks.length - 1 ? payload.buttons : undefined,
              });
        if (!delivered || index === textChunks.length - 1) {
          delivered = buildTelegramDeliveredRef(conversation, result);
        }
      }
      this.params.api.logger.debug?.(
        `codex outbound send complete ${this.params.formatConversationForLog(conversation)} channel=telegram chunks=${textChunks.length} media=no`,
      );
      return delivered;
    }
    if (isDiscordChannel(conversation.channel)) {
      const outbound = await this.params.loadDiscordOutboundAdapter();
      const outboundCfg = this.params.getConfig();
      const mediaLocalRoots = this.params.resolveReplyMediaLocalRoots(payload.mediaUrl);
      const limit = this.params.api.runtime.channel.text.resolveTextChunkLimit(
        undefined,
        "discord",
        conversation.accountId,
        { fallbackLimit: 2000 },
      );
      const chunks = text
        ? this.params.api.runtime.channel.text.chunkText(text, limit).filter(Boolean)
        : [];
      let delivered: DeliveredMessageRef | null = null;
      if (payload.buttons && payload.buttons.length > 0) {
        this.params.api.logger.debug?.(
          `codex discord reply send conversation=${conversation.conversationId} rows=${payload.buttons.length}`,
        );
        const attachmentChunk = hasMedia ? (chunks.shift() ?? text) : undefined;
        if (hasMedia) {
          const result = await this.sendDiscordTextChunk(outbound, conversation, attachmentChunk ?? "", {
            mediaUrl: payload.mediaUrl,
            mediaLocalRoots,
          });
          delivered = buildDiscordDeliveredRef(conversation, result);
        }
        const finalChunk = chunks.pop() ?? (hasMedia ? "" : text);
        for (const chunk of chunks) {
          const result = await this.sendDiscordTextChunk(outbound, conversation, chunk);
          if (!delivered) {
            delivered = buildDiscordDeliveredRef(conversation, result);
          }
        }
        const picker = {
          text: finalChunk,
          buttons: payload.buttons,
        };
        if (outboundCfg && outbound?.sendPayload) {
          const result = await outbound.sendPayload({
            cfg: outboundCfg,
            to: conversation.conversationId,
            text: finalChunk,
            payload: {
              text: finalChunk,
              channelData: {
                discord: {
                  components: this.params.buildDiscordPickerSpec(picker),
                },
              },
            },
            accountId: conversation.accountId,
            mediaLocalRoots,
          });
          delivered = buildDiscordDeliveredRef(conversation, result);
        } else {
          const result = await this.params.sendDiscordPickerMessageLegacy(conversation, picker);
          if (result) {
            delivered = buildDiscordDeliveredRef(conversation, result);
          }
        }
        this.params.api.logger.debug?.(
          `codex outbound send complete ${this.params.formatConversationForLog(conversation)} channel=discord chunks=${chunks.length + 1 + (hasMedia ? 1 : 0)} media=${hasMedia ? "yes" : "no"} buttons=${payload.buttons.length}`,
        );
        return delivered;
      }
      const textChunks = chunks.length > 0 ? chunks : [text];
      if (hasMedia) {
        const firstChunk = textChunks.shift() ?? "";
        const result = await this.sendDiscordTextChunk(outbound, conversation, firstChunk, {
          mediaUrl: payload.mediaUrl,
          mediaLocalRoots,
        });
        delivered = buildDiscordDeliveredRef(conversation, result);
      }
      for (const chunk of textChunks) {
        if (!chunk) {
          continue;
        }
        const result = await this.sendDiscordTextChunk(outbound, conversation, chunk);
        if (!delivered) {
          delivered = buildDiscordDeliveredRef(conversation, result);
        }
      }
      this.params.api.logger.debug?.(
        `codex outbound send complete ${this.params.formatConversationForLog(conversation)} channel=discord chunks=${textChunks.length + (hasMedia ? 1 : 0)} media=${hasMedia ? "yes" : "no"}`,
      );
      return delivered;
    }
    return null;
  }

  async sendTelegramTextChunk(
    outbound: ProviderOutboundAdapter | undefined,
    conversation: ConversationTarget,
    text: string,
    opts?: { buttons?: PluginInteractiveButtons },
  ): Promise<{ messageId: string; chatId?: string }> {
    const target = conversation.parentConversationId ?? conversation.conversationId;
    const buttons = opts?.buttons;
    const cfg = this.params.getConfig();
    if (buttons && cfg && outbound?.sendPayload) {
      return await outbound.sendPayload({
        cfg,
        to: target,
        text,
        payload: {
          text,
          channelData: {
            telegram: {
              buttons,
            },
          },
        },
        accountId: conversation.accountId,
        threadId: conversation.threadId,
      });
    }
    const legacySend = getLegacyTelegramRuntime(this.params.api)?.sendMessageTelegram;
    if (buttons && typeof legacySend === "function") {
      return await legacySend(target, text, {
        accountId: conversation.accountId,
        messageThreadId: typeof conversation.threadId === "number" ? conversation.threadId : undefined,
        buttons,
      });
    }
    if (!buttons && cfg && outbound?.sendText) {
      return await outbound.sendText({
        cfg,
        to: target,
        text,
        accountId: conversation.accountId,
        threadId: conversation.threadId,
      });
    }
    if (typeof legacySend === "function") {
      return await legacySend(target, text, {
        accountId: conversation.accountId,
        messageThreadId: typeof conversation.threadId === "number" ? conversation.threadId : undefined,
        buttons,
      });
    }
    const runtimeApi = await this.params.loadTelegramRuntimeApi();
    if (typeof runtimeApi?.sendMessageTelegram === "function") {
      return await runtimeApi.sendMessageTelegram(target, text, {
        cfg: this.params.getConfig(),
        accountId: conversation.accountId,
        messageThreadId: typeof conversation.threadId === "number" ? conversation.threadId : undefined,
        ...(buttons ? { buttons } : {}),
      });
    }
    throw new Error("Telegram send runtime unavailable");
  }

  async sendTelegramMediaChunk(
    outbound: ProviderOutboundAdapter | undefined,
    conversation: ConversationTarget,
    text: string,
    opts: {
      mediaUrl?: string;
      mediaLocalRoots?: readonly string[];
      buttons?: PluginInteractiveButtons;
    },
  ): Promise<{ messageId: string; chatId?: string }> {
    if (!opts.mediaUrl) {
      throw new Error("Telegram media send requires mediaUrl");
    }
    const target = conversation.parentConversationId ?? conversation.conversationId;
    const cfg = this.params.getConfig();
    if (opts.buttons && cfg && outbound?.sendPayload) {
      return await outbound.sendPayload({
        cfg,
        to: target,
        text,
        payload: {
          text,
          mediaUrl: opts.mediaUrl,
          channelData: {
            telegram: {
              buttons: opts.buttons,
            },
          },
        },
        mediaLocalRoots: opts.mediaLocalRoots,
        accountId: conversation.accountId,
        threadId: conversation.threadId,
      });
    }
    const legacySend = getLegacyTelegramRuntime(this.params.api)?.sendMessageTelegram;
    if (opts.buttons && typeof legacySend === "function") {
      return await legacySend(target, text, {
        accountId: conversation.accountId,
        messageThreadId: typeof conversation.threadId === "number" ? conversation.threadId : undefined,
        mediaUrl: opts.mediaUrl,
        mediaLocalRoots: opts.mediaLocalRoots,
        buttons: opts.buttons,
      });
    }
    if (!opts.buttons && cfg && outbound?.sendMedia) {
      return await outbound.sendMedia({
        cfg,
        to: target,
        text,
        mediaUrl: opts.mediaUrl,
        mediaLocalRoots: opts.mediaLocalRoots,
        accountId: conversation.accountId,
        threadId: conversation.threadId,
      });
    }
    if (typeof legacySend === "function") {
      return await legacySend(target, text, {
        accountId: conversation.accountId,
        messageThreadId: typeof conversation.threadId === "number" ? conversation.threadId : undefined,
        mediaUrl: opts.mediaUrl,
        mediaLocalRoots: opts.mediaLocalRoots,
        buttons: opts.buttons,
      });
    }
    const runtimeApi = await this.params.loadTelegramRuntimeApi();
    if (typeof runtimeApi?.sendMessageTelegram === "function") {
      return await runtimeApi.sendMessageTelegram(target, text, {
        cfg: this.params.getConfig(),
        accountId: conversation.accountId,
        messageThreadId: typeof conversation.threadId === "number" ? conversation.threadId : undefined,
        mediaUrl: opts.mediaUrl,
        mediaLocalRoots: opts.mediaLocalRoots,
        ...(opts.buttons ? { buttons: opts.buttons } : {}),
      });
    }
    throw new Error("Telegram media send runtime unavailable");
  }

  async sendDiscordTextChunk(
    outbound: ProviderOutboundAdapter | undefined,
    conversation: ConversationTarget,
    text: string,
    opts?: { mediaUrl?: string; mediaLocalRoots?: readonly string[] },
  ): Promise<{ messageId: string; channelId?: string }> {
    const mediaUrl = opts?.mediaUrl;
    const mediaLocalRoots = opts?.mediaLocalRoots;
    const cfg = this.params.getConfig();
    if (mediaUrl && cfg && outbound?.sendMedia) {
      return await outbound.sendMedia({
        cfg,
        to: conversation.conversationId,
        text,
        mediaUrl,
        accountId: conversation.accountId,
        mediaLocalRoots,
      });
    }
    if (!mediaUrl && cfg && outbound?.sendText) {
      return await outbound.sendText({
        cfg,
        to: conversation.conversationId,
        text,
        accountId: conversation.accountId,
      });
    }
    const legacySend = getLegacyDiscordRuntime(this.params.api)?.sendMessageDiscord;
    if (typeof legacySend === "function") {
      return await legacySend(conversation.conversationId, text, {
        accountId: conversation.accountId,
        mediaUrl,
        mediaLocalRoots,
      });
    }
    const runtimeApi = await this.params.loadDiscordRuntimeApi();
    if (typeof runtimeApi?.sendMessageDiscord === "function") {
      return await runtimeApi.sendMessageDiscord(conversation.conversationId, text, {
        cfg: this.params.getConfig(),
        accountId: conversation.accountId,
        mediaUrl,
        mediaLocalRoots,
      });
    }
    throw new Error("Discord outbound messaging is unavailable.");
  }

  async sendSingleTextWithDeliveryRef(
    conversation: ConversationTarget,
    text: string,
  ): Promise<DeliveredMessageRef | null> {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }
    if (isTelegramChannel(conversation.channel)) {
      const outbound = await this.params.loadTelegramOutboundAdapter();
      const result = await this.sendTelegramTextChunk(outbound, conversation, trimmed);
      return buildTelegramDeliveredRef(conversation, result);
    }
    if (isDiscordChannel(conversation.channel)) {
      const outbound = await this.params.loadDiscordOutboundAdapter();
      const result = await this.sendDiscordTextChunk(outbound, conversation, trimmed);
      return buildDiscordDeliveredRef(conversation, result);
    }
    return null;
  }

  async sendTextWithDeliveryRef(
    conversation: ConversationTarget,
    text: string,
  ): Promise<DeliveredMessageRef | null> {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }
    if (isTelegramChannel(conversation.channel)) {
      const outbound = await this.params.loadTelegramOutboundAdapter();
      const limit = this.params.api.runtime.channel.text.resolveTextChunkLimit(
        undefined,
        "telegram",
        conversation.accountId,
        { fallbackLimit: 4000 },
      );
      const chunks = this.params.api.runtime.channel.text.chunkText(trimmed, limit).filter(Boolean);
      const textChunks = chunks.length > 0 ? chunks : [trimmed];
      let firstDelivered: DeliveredMessageRef | null = null;
      for (const chunk of textChunks) {
        const result = await this.sendTelegramTextChunk(outbound, conversation, chunk);
        if (!firstDelivered) {
          firstDelivered = buildTelegramDeliveredRef(conversation, result);
        }
      }
      return firstDelivered;
    }
    if (isDiscordChannel(conversation.channel)) {
      const outbound = await this.params.loadDiscordOutboundAdapter();
      const limit = this.params.api.runtime.channel.text.resolveTextChunkLimit(
        undefined,
        "discord",
        conversation.accountId,
        { fallbackLimit: 2000 },
      );
      const chunks = this.params.api.runtime.channel.text.chunkText(trimmed, limit).filter(Boolean);
      const textChunks = chunks.length > 0 ? chunks : [trimmed];
      let firstDelivered: DeliveredMessageRef | null = null;
      for (const chunk of textChunks) {
        const result = await this.sendDiscordTextChunk(outbound, conversation, chunk);
        if (!firstDelivered) {
          firstDelivered = buildDiscordDeliveredRef(conversation, result);
        }
      }
      return firstDelivered;
    }
    return null;
  }

  async pinTelegramMessage(
    chatId: string,
    messageId: string,
    opts?: { accountId?: string; disableNotification?: boolean },
  ): Promise<void> {
    const runtimeApi = await this.params.loadTelegramRuntimeApi();
    if (typeof runtimeApi?.pinMessageTelegram === "function") {
      await runtimeApi.pinMessageTelegram(chatId, messageId, {
        cfg: this.params.getConfig(),
        accountId: opts?.accountId,
      });
      return;
    }
    const token = await this.params.resolveTelegramBotToken(opts?.accountId);
    if (!token) {
      this.params.api.logger.debug?.(`codex telegram pin skipped chat=${chatId} reason=no-token`);
      return;
    }
    await this.callTelegramPinApi("pinChatMessage", token, {
      chat_id: chatId,
      message_id: Number(messageId),
      disable_notification: opts?.disableNotification ?? false,
    });
  }

  async unpinTelegramMessage(
    chatId: string,
    messageId: string,
    opts?: { accountId?: string },
  ): Promise<void> {
    const runtimeApi = await this.params.loadTelegramRuntimeApi();
    if (typeof runtimeApi?.unpinMessageTelegram === "function") {
      await runtimeApi.unpinMessageTelegram(chatId, messageId, {
        cfg: this.params.getConfig(),
        accountId: opts?.accountId,
      });
      return;
    }
    const token = await this.params.resolveTelegramBotToken(opts?.accountId);
    if (!token) {
      this.params.api.logger.debug?.(`codex telegram unpin skipped chat=${chatId} reason=no-token`);
      return;
    }
    await this.callTelegramPinApi("unpinChatMessage", token, {
      chat_id: chatId,
      message_id: Number(messageId),
    });
  }

  async editTelegramMessage(
    chatId: string,
    messageId: string,
    text: string,
    opts?: { accountId?: string; buttons?: PluginInteractiveButtons },
  ): Promise<void> {
    const runtimeApi = await this.params.loadTelegramRuntimeApi();
    if (typeof runtimeApi?.editMessageTelegram === "function") {
      await runtimeApi.editMessageTelegram(chatId, messageId, text, {
        cfg: this.params.getConfig(),
        accountId: opts?.accountId,
        ...(opts?.buttons ? { buttons: opts.buttons } : {}),
      });
      return;
    }
    const token = await this.params.resolveTelegramBotToken(opts?.accountId);
    if (!token) {
      throw new Error("Telegram edit skipped because no bot token was available");
    }
    await this.callTelegramEditMessageApi(token, {
      chat_id: chatId,
      message_id: Number(messageId),
      text,
      ...(opts?.buttons
        ? { reply_markup: buildTelegramReplyMarkup(opts.buttons) ?? { inline_keyboard: [] } }
        : {}),
    });
  }

  async renameTelegramTopic(
    chatId: string,
    messageThreadId: number,
    name: string,
    opts?: { accountId?: string },
  ): Promise<void> {
    const runtimeApi = await this.params.loadTelegramRuntimeApi();
    if (typeof runtimeApi?.renameForumTopicTelegram === "function") {
      await runtimeApi.renameForumTopicTelegram(chatId, messageThreadId, name, {
        cfg: this.params.getConfig(),
        accountId: opts?.accountId,
      });
      return;
    }
    const token = await this.params.resolveTelegramBotToken(opts?.accountId);
    if (!token) {
      return;
    }
    await this.callTelegramTopicEditApi(token, {
      chat_id: chatId,
      message_thread_id: messageThreadId,
      name,
    });
  }

  async pinDiscordMessage(
    channelId: string,
    messageId: string,
    opts?: { accountId?: string },
  ): Promise<void> {
    const runtimeApi = await this.params.loadDiscordRuntimeApi();
    if (typeof runtimeApi?.pinMessageDiscord === "function") {
      await runtimeApi.pinMessageDiscord(channelId, messageId, {
        cfg: this.params.getConfig(),
        accountId: opts?.accountId,
      });
      return;
    }
    const token = await this.params.resolveDiscordBotToken(opts?.accountId);
    if (!token) {
      this.params.api.logger.debug?.(`codex discord pin skipped channel=${channelId} reason=no-token`);
      return;
    }
    await this.callDiscordPinApi("pin", token, channelId, messageId);
  }

  async unpinDiscordMessage(
    channelId: string,
    messageId: string,
    opts?: { accountId?: string },
  ): Promise<void> {
    const runtimeApi = await this.params.loadDiscordRuntimeApi();
    if (typeof runtimeApi?.unpinMessageDiscord === "function") {
      await runtimeApi.unpinMessageDiscord(channelId, messageId, {
        cfg: this.params.getConfig(),
        accountId: opts?.accountId,
      });
      return;
    }
    const token = await this.params.resolveDiscordBotToken(opts?.accountId);
    if (!token) {
      this.params.api.logger.debug?.(`codex discord unpin skipped channel=${channelId} reason=no-token`);
      return;
    }
    await this.callDiscordPinApi("unpin", token, channelId, messageId);
  }

  async renameConversationIfSupported(
    conversation: ConversationTarget,
    name: string,
  ): Promise<void> {
    if (isTelegramChannel(conversation.channel) && conversation.threadId != null) {
      const legacyRename = getLegacyTelegramRuntime(this.params.api)?.conversationActions?.renameTopic;
      if (typeof legacyRename === "function") {
        await legacyRename(
          conversation.parentConversationId ?? conversation.conversationId,
          conversation.threadId,
          name,
          {
            accountId: conversation.accountId,
          },
        ).catch((error) => {
          this.params.api.logger.warn(`codex telegram topic rename failed: ${String(error)}`);
        });
        return;
      }
      await this.renameTelegramTopic(
        conversation.parentConversationId ?? conversation.conversationId,
        conversation.threadId,
        name,
        {
          accountId: conversation.accountId,
        },
      ).catch((error) => {
        this.params.api.logger.warn(`codex telegram topic rename failed: ${String(error)}`);
      });
      return;
    }
    if (isDiscordChannel(conversation.channel)) {
      const legacyEditChannel = getLegacyDiscordRuntime(this.params.api)?.conversationActions?.editChannel;
      if (typeof legacyEditChannel !== "function") {
        const runtimeApi = await this.params.loadDiscordRuntimeApi();
        if (typeof runtimeApi?.editChannelDiscord !== "function") {
          return;
        }
        await runtimeApi.editChannelDiscord(
          {
            channelId:
              this.params.denormalizeDiscordConversationId(conversation.conversationId) ??
              conversation.conversationId,
            name,
          },
          {
            cfg: this.params.getConfig(),
            accountId: conversation.accountId,
          },
        ).catch((error) => {
          this.params.api.logger.warn(`codex discord channel rename failed: ${String(error)}`);
        });
        return;
      }
      await legacyEditChannel(
        conversation.conversationId,
        {
          name,
        },
        {
          accountId: conversation.accountId,
        },
      ).catch((error) => {
        this.params.api.logger.warn(`codex discord channel rename failed: ${String(error)}`);
      });
    }
  }

  private async callDiscordPinApi(
    action: "pin" | "unpin",
    token: string,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/pins/${encodeURIComponent(messageId)}`,
      {
        method: action === "pin" ? "PUT" : "DELETE",
        headers: {
          Authorization: `Bot ${token}`,
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `Discord ${action} failed status=${response.status} body=${await response.text()}`,
      );
    }
  }

  private async callTelegramBotApi(
    method: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Telegram ${method} failed status=${response.status} body=${responseText}`);
    }
    const trimmedBody = responseText.trim();
    if (!trimmedBody) {
      return;
    }
    try {
      const parsed = JSON.parse(trimmedBody) as { ok?: unknown; description?: unknown };
      if (parsed.ok === false) {
        const description =
          typeof parsed.description === "string" && parsed.description.trim()
            ? parsed.description.trim()
            : trimmedBody;
        throw new Error(`Telegram ${method} failed body=${description}`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        return;
      }
      throw error;
    }
  }

  private async callTelegramPinApi(
    method: "pinChatMessage" | "unpinChatMessage",
    token: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    await this.callTelegramBotApi(method, token, body);
  }

  private async callTelegramEditMessageApi(
    token: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    await this.callTelegramBotApi("editMessageText", token, body);
  }

  private async callTelegramTopicEditApi(
    token: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    await this.callTelegramBotApi("editForumTopic", token, body);
  }
}
