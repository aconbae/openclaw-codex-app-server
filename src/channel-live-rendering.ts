import type {
  DiscordComponentBuildResult,
  DiscordComponentMessageSpec,
} from "./discord-component-types.js";
import type { OpenClawPluginApi, PluginInteractiveButtons } from "./openclaw-types.js";
import type { ConversationTarget, InteractiveMessageRef } from "./types.js";

type DeliveredMessageRef = InteractiveMessageRef;

type DiscordPickerRender = {
  text: string;
  buttons: PluginInteractiveButtons | undefined;
};

export type LiveAssistantReplyWriter = {
  update: (text: string) => Promise<void>;
  finalize: (text?: string) => Promise<boolean>;
};

export type StatusCardRender = {
  text: string;
  buttons?: PluginInteractiveButtons;
};

const DISCORD_LIVE_ASSISTANT_PREVIEW_THROTTLE_MS = 1_200;
const DISCORD_LIVE_ASSISTANT_PREVIEW_MIN_CHARS = 30;
const DISCORD_LIVE_ASSISTANT_PREVIEW_MAX_CHARS = 2_000;

function isTelegramChannel(channel: string): boolean {
  return channel.trim().toLowerCase() === "telegram";
}

function isDiscordChannel(channel: string): boolean {
  return channel.trim().toLowerCase() === "discord";
}

export type OpenClawChannelLiveRenderingParams = {
  api: OpenClawPluginApi;
  formatConversationForLog: (conversation: ConversationTarget) => string;
  editTelegramMessage: (
    chatId: string,
    messageId: string,
    text: string,
    opts?: { accountId?: string; buttons?: PluginInteractiveButtons },
  ) => Promise<void>;
  editDiscordComponentMessage: (
    to: string,
    messageId: string,
    spec: DiscordComponentMessageSpec,
    opts?: { accountId?: string },
  ) => Promise<{ messageId: string; channelId: string }>;
  registerBuiltDiscordComponentMessage: (params: {
    buildResult: DiscordComponentBuildResult;
    messageId: string;
  }) => Promise<void>;
  buildDiscordPickerSpec: (picker: DiscordPickerRender) => DiscordComponentMessageSpec;
  buildDiscordPickerMessage: (picker: DiscordPickerRender) => Promise<DiscordComponentBuildResult>;
  buildDiscordTextMessage: (params: {
    text: string;
    accountId?: string;
  }) => Promise<DiscordComponentBuildResult>;
  sendTextWithDeliveryRef: (
    conversation: ConversationTarget,
    text: string,
  ) => Promise<DeliveredMessageRef | null>;
  sendSingleTextWithDeliveryRef: (
    conversation: ConversationTarget,
    text: string,
  ) => Promise<DeliveredMessageRef | null>;
};

export class OpenClawChannelLiveRendering {
  constructor(private readonly params: OpenClawChannelLiveRenderingParams) {}

  async updateStatusCardMessage(
    conversation: ConversationTarget,
    message: InteractiveMessageRef,
    statusCard: StatusCardRender,
  ): Promise<boolean> {
    try {
      if (message.provider === "telegram") {
        await this.params.editTelegramMessage(message.chatId, message.messageId, statusCard.text, {
          accountId: conversation.accountId,
          buttons: statusCard.buttons ?? [],
        });
        return true;
      }
      const builtPicker = await this.params.buildDiscordPickerMessage({
        text: statusCard.text,
        buttons: statusCard.buttons,
      });
      await this.params.editDiscordComponentMessage(
        message.channelId,
        message.messageId,
        this.params.buildDiscordPickerSpec({
          text: statusCard.text,
          buttons: statusCard.buttons,
        }),
        {
          accountId: conversation.accountId,
        },
      );
      await this.params.registerBuiltDiscordComponentMessage({
        buildResult: builtPicker,
        messageId: message.messageId,
      });
      return true;
    } catch (error) {
      this.params.api.logger.warn(
        `codex status card update failed ${this.params.formatConversationForLog(conversation)} provider=${message.provider}: ${String(error)}`,
      );
      return false;
    }
  }

  async updateDeliveredTextMessage(
    conversation: ConversationTarget,
    message: DeliveredMessageRef,
    text: string,
  ): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }
    try {
      if (message.provider === "telegram") {
        await this.params.editTelegramMessage(message.chatId, message.messageId, trimmed, {
          accountId: conversation.accountId,
        });
        return true;
      }
      const spec: DiscordComponentMessageSpec = {
        text: trimmed,
      };
      await this.params.editDiscordComponentMessage(message.channelId, message.messageId, spec, {
        accountId: conversation.accountId,
      });
      await this.params.registerBuiltDiscordComponentMessage({
        buildResult: await this.params.buildDiscordTextMessage({
          text: trimmed,
          accountId: conversation.accountId,
        }),
        messageId: message.messageId,
      });
      return true;
    } catch (error) {
      this.params.api.logger.warn(
        `codex live assistant message update failed ${this.params.formatConversationForLog(conversation)} provider=${message.provider}: ${String(error)}`,
      );
      return false;
    }
  }

  createLiveAssistantReplyWriter(conversation: ConversationTarget): LiveAssistantReplyWriter {
    if (isDiscordChannel(conversation.channel)) {
      return this.createDiscordLiveAssistantReplyWriter(conversation);
    }
    return this.createChunkedLiveAssistantReplyWriter(conversation);
  }

  private createChunkedLiveAssistantReplyWriter(
    conversation: ConversationTarget,
  ): LiveAssistantReplyWriter {
    const fallbackLimit = isTelegramChannel(conversation.channel) ? 4000 : 2000;
    const chunkLimit = this.params.api.runtime.channel.text.resolveTextChunkLimit(
      undefined,
      conversation.channel,
      conversation.accountId,
      { fallbackLimit },
    );
    const chunkText = (text: string): string[] => {
      const trimmed = text.trim();
      if (!trimmed) {
        return [];
      }
      const chunks = this.params.api.runtime.channel.text.chunkText(trimmed, chunkLimit).filter(Boolean);
      return chunks.length > 0 ? chunks : [trimmed];
    };

    let deliveredChunks: DeliveredMessageRef[] = [];
    let renderedChunks: string[] = [];
    let renderedText = "";
    let pendingText = "";
    let renderQueue = Promise.resolve();

    const renderLatest = async () => {
      const nextText = pendingText.trim();
      if (!nextText || nextText === renderedText) {
        return;
      }
      if (renderedText && nextText.length < renderedText.length) {
        return;
      }
      const nextChunks = chunkText(nextText);
      for (let index = 0; index < nextChunks.length; index += 1) {
        const chunk = nextChunks[index];
        if (!chunk) {
          continue;
        }
        const delivered = deliveredChunks[index];
        if (delivered) {
          if (renderedChunks[index] !== chunk) {
            const updated = await this.updateDeliveredTextMessage(conversation, delivered, chunk);
            if (!updated) {
              return;
            }
          }
          continue;
        }
        const nextDelivered = await this.params.sendTextWithDeliveryRef(conversation, chunk);
        if (!nextDelivered) {
          return;
        }
        deliveredChunks.push(nextDelivered);
      }
      renderedChunks = nextChunks;
      renderedText = nextText;
    };

    const enqueueRender = () => {
      renderQueue = renderQueue
        .then(renderLatest)
        .catch((error: unknown) => {
          this.params.api.logger.warn(
            `codex live assistant render failed ${this.params.formatConversationForLog(conversation)}: ${String(error)}`,
          );
        });
      return renderQueue;
    };

    return {
      update: async (text: string) => {
        const trimmed = text.trim();
        if (!trimmed) {
          return;
        }
        pendingText = trimmed;
        await enqueueRender();
      },
      finalize: async (text?: string) => {
        const trimmed = text?.trim();
        if (trimmed) {
          pendingText = trimmed;
          await enqueueRender();
        } else {
          await renderQueue;
        }
        return trimmed ? renderedText === trimmed : renderedChunks.length > 0;
      },
    };
  }

  private createDiscordLiveAssistantReplyWriter(
    conversation: ConversationTarget,
  ): LiveAssistantReplyWriter {
    const chunkLimit = this.params.api.runtime.channel.text.resolveTextChunkLimit(
      undefined,
      "discord",
      conversation.accountId,
      { fallbackLimit: DISCORD_LIVE_ASSISTANT_PREVIEW_MAX_CHARS },
    );
    const chunkText = (text: string): string[] => {
      const trimmed = text.trim();
      if (!trimmed) {
        return [];
      }
      const chunks = this.params.api.runtime.channel.text.chunkText(trimmed, chunkLimit).filter(Boolean);
      return chunks.length > 0 ? chunks : [trimmed];
    };

    let previewMessage: DeliveredMessageRef | null = null;
    let previewText = "";
    let observedText = "";
    let pendingPreviewText = "";
    let previewQueue = Promise.resolve();
    let previewTimer: ReturnType<typeof setTimeout> | null = null;

    const clearPreviewTimer = () => {
      if (!previewTimer) {
        return;
      }
      clearTimeout(previewTimer);
      previewTimer = null;
    };

    const renderPreview = async () => {
      previewTimer = null;
      const nextText = pendingPreviewText.trim();
      if (!nextText || nextText === previewText) {
        return;
      }
      if (!previewMessage && nextText.length < DISCORD_LIVE_ASSISTANT_PREVIEW_MIN_CHARS) {
        return;
      }
      if (nextText.length > DISCORD_LIVE_ASSISTANT_PREVIEW_MAX_CHARS) {
        return;
      }
      if (previewText && previewText.startsWith(nextText) && nextText.length < previewText.length) {
        return;
      }
      if (!previewMessage) {
        previewMessage = await this.params.sendSingleTextWithDeliveryRef(conversation, nextText);
        if (!previewMessage) {
          return;
        }
        previewText = nextText;
        return;
      }
      const updated = await this.updateDeliveredTextMessage(conversation, previewMessage, nextText);
      if (!updated) {
        return;
      }
      previewText = nextText;
    };

    const enqueuePreviewRender = () => {
      previewQueue = previewQueue
        .then(renderPreview)
        .catch((error: unknown) => {
          this.params.api.logger.warn(
            `codex live assistant preview render failed ${this.params.formatConversationForLog(conversation)}: ${String(error)}`,
          );
        });
      return previewQueue;
    };

    const schedulePreviewRender = () => {
      if (previewTimer) {
        return;
      }
      previewTimer = setTimeout(() => {
        void enqueuePreviewRender();
      }, DISCORD_LIVE_ASSISTANT_PREVIEW_THROTTLE_MS);
    };

    return {
      update: async (text: string) => {
        const trimmed = text.trim();
        if (!trimmed) {
          return;
        }
        if (observedText && observedText.startsWith(trimmed) && trimmed.length < observedText.length) {
          return;
        }
        observedText = trimmed;
        pendingPreviewText = trimmed;
        if (trimmed.length >= DISCORD_LIVE_ASSISTANT_PREVIEW_MIN_CHARS || previewMessage) {
          schedulePreviewRender();
        }
      },
      finalize: async (text?: string) => {
        clearPreviewTimer();
        await previewQueue;

        const explicitFinalText = text?.trim();
        const finalSource = explicitFinalText || observedText.trim();
        if (!previewMessage) {
          if (!explicitFinalText && finalSource) {
            const delivered = await this.params.sendTextWithDeliveryRef(conversation, finalSource);
            return delivered !== null;
          }
          return false;
        }
        if (!finalSource) {
          return previewText.length > 0;
        }

        const finalChunks = chunkText(finalSource);
        if (finalChunks.length === 0) {
          return previewText.length > 0;
        }
        const [firstChunk, ...spilloverChunks] = finalChunks;
        if (firstChunk && firstChunk !== previewText) {
          const updated = await this.updateDeliveredTextMessage(conversation, previewMessage, firstChunk);
          if (!updated) {
            return false;
          }
          previewText = firstChunk;
        }
        for (const chunk of spilloverChunks) {
          const delivered = await this.params.sendSingleTextWithDeliveryRef(conversation, chunk);
          if (!delivered) {
            return false;
          }
        }
        return true;
      },
    };
  }
}
