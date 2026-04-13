import type {
  DiscordComponentBuildResult,
  DiscordComponentMessageSpec,
} from "./discord-component-types.js";
import type {
  OpenClawPluginApi,
  PluginConversationBinding,
  PluginConversationBindingRequestResult,
  PluginInteractiveButtons,
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveTelegramHandlerContext,
  ReplyPayload,
} from "./openclaw-types.js";
import type { CallbackAction, ConversationTarget, InteractiveMessageRef } from "./types.js";

type PickerRender = {
  text: string;
  buttons: PluginInteractiveButtons | undefined;
};

type PickerResponders = {
  conversation: ConversationTarget;
  sourceMessage?: InteractiveMessageRef;
  acknowledge?: () => Promise<void>;
  clear: () => Promise<void>;
  reply: (text: string) => Promise<void>;
  editPicker: (picker: PickerRender) => Promise<void>;
  requestConversationBinding?: (
    params?: { summary?: string },
  ) => Promise<PluginConversationBindingRequestResult>;
  detachConversationBinding?: () => Promise<{ removed: boolean }>;
};

type ScopedBindingApi = {
  requestConversationBinding?: (
    params?: { summary?: string },
  ) => Promise<PluginConversationBindingRequestResult>;
  detachConversationBinding?: () => Promise<{ removed: boolean }>;
  getCurrentConversationBinding?: () => Promise<PluginConversationBinding | null>;
};

function asScopedBindingApi(value: object): ScopedBindingApi {
  return value as ScopedBindingApi;
}

export type OpenClawChannelInteractiveOrchestrationParams = {
  api: OpenClawPluginApi;
  getCallback: (token: string) => CallbackAction | undefined;
  dispatchCallbackAction: (
    callback: CallbackAction,
    responders: PickerResponders,
  ) => Promise<void>;
  normalizeDiscordConversationId: (raw: string | undefined) => string | undefined;
  normalizeDiscordInteractiveConversationId: (params: {
    conversationId?: string;
    guildId?: string;
  }) => string | undefined;
  extractReplyButtons: (reply: ReplyPayload) => PluginInteractiveButtons | undefined;
  buildDiscordPickerSpec: (picker: PickerRender) => DiscordComponentMessageSpec;
  tryBuildDiscordPickerMessage: (
    picker: PickerRender,
  ) => Promise<DiscordComponentBuildResult | undefined>;
  registerBuiltDiscordComponentMessage: (params: {
    buildResult: DiscordComponentBuildResult;
    messageId: string;
  }) => Promise<void>;
  editDiscordComponentMessage: (
    to: string,
    messageId: string,
    spec: DiscordComponentMessageSpec,
    opts?: { accountId?: string },
  ) => Promise<{ messageId: string; channelId: string }>;
  sendDiscordPicker: (conversation: ConversationTarget, picker: PickerRender) => Promise<void>;
};

export class OpenClawChannelInteractiveOrchestration {
  constructor(private readonly params: OpenClawChannelInteractiveOrchestrationParams) {}

  async handleTelegramInteractive(ctx: PluginInteractiveTelegramHandlerContext): Promise<void> {
    const bindingApi = asScopedBindingApi(ctx);
    const callback = this.params.getCallback(ctx.callback.payload);
    if (!callback) {
      await ctx.respond.reply({ text: "That Codex action expired. Please retry the command." });
      return;
    }
    await this.params.dispatchCallbackAction(callback, {
      conversation: {
        channel: "telegram",
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        parentConversationId: ctx.parentConversationId,
        threadId: ctx.threadId,
      },
      sourceMessage:
        ctx.callback.messageId != null && ctx.callback.chatId?.trim()
          ? {
              provider: "telegram",
              messageId: String(ctx.callback.messageId),
              chatId: ctx.callback.chatId,
            }
          : undefined,
      acknowledge: async () => {},
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
      requestConversationBinding: async (params) => {
        const requestConversationBinding = bindingApi.requestConversationBinding;
        if (!requestConversationBinding) {
          return { status: "error", message: "Conversation binding is unavailable." } as const;
        }
        const result = await requestConversationBinding(params);
        if (result.status === "pending") {
          const buttons = this.params.extractReplyButtons(result.reply);
          await ctx.respond.reply({
            text: result.reply.text ?? "Bind approval requested.",
            buttons,
          });
          return result;
        }
        return result;
      },
      detachConversationBinding: bindingApi.detachConversationBinding,
    });
  }

  async handleDiscordInteractive(ctx: PluginInteractiveDiscordHandlerContext): Promise<void> {
    const bindingApi = asScopedBindingApi(ctx);
    const callback = this.params.getCallback(ctx.interaction.payload);
    if (!callback) {
      await ctx.respond.reply({
        text: "That Codex action expired. Please retry the command.",
        ephemeral: true,
      });
      return;
    }
    const callbackConversationId =
      callback.conversation.channel === "discord"
        ? this.params.normalizeDiscordConversationId(callback.conversation.conversationId)
        : undefined;
    const conversationId =
      callbackConversationId ??
      this.params.normalizeDiscordInteractiveConversationId({
        conversationId: ctx.conversationId,
        guildId: ctx.guildId,
      });
    if (!conversationId) {
      await ctx.respond.reply({
        text: "I couldn’t determine the Discord conversation for that action. Please retry the command.",
        ephemeral: true,
      });
      return;
    }
    const conversation: ConversationTarget = {
      channel: "discord",
      accountId: callback.conversation.accountId ?? ctx.accountId,
      conversationId,
      parentConversationId: callback.conversation.parentConversationId ?? ctx.parentConversationId,
    };
    let interactionSettled = false;
    try {
      if (callback.kind === "resume-thread") {
        await ctx.respond
          .acknowledge()
          .then(() => {
            interactionSettled = true;
          })
          .catch(() => undefined);
      }
      await this.params.dispatchCallbackAction(callback, {
        conversation,
        sourceMessage: ctx.interaction.messageId?.trim()
          ? {
              provider: "discord",
              messageId: ctx.interaction.messageId.trim(),
              channelId: conversation.conversationId,
            }
          : undefined,
        acknowledge: async () => {
          if (interactionSettled) {
            return;
          }
          await ctx.respond
            .acknowledge()
            .then(() => {
              interactionSettled = true;
            })
            .catch(() => undefined);
        },
        clear: async () => {
          const messageId = ctx.interaction.messageId?.trim();
          if ((callback.kind === "pending-input" || callback.kind === "pending-questionnaire") && messageId) {
            await ctx.respond
              .acknowledge()
              .then(() => {
                interactionSettled = true;
              })
              .catch(() => undefined);
            const completionText =
              callback.kind === "pending-questionnaire"
                ? "Recorded your answers and sent them to Codex."
                : "Sent to Codex.";
            await this.params.editDiscordComponentMessage(
              conversation.conversationId,
              messageId,
              {
                text: completionText,
              },
              {
                accountId: conversation.accountId,
              },
            ).catch((error) => {
              this.params.api.logger.warn(
                `codex discord ${callback.kind} clear failed conversation=${conversationId}: ${String(error)}`,
              );
            });
            return;
          }
          try {
            await ctx.respond.clearComponents();
            interactionSettled = true;
          } catch {
            await ctx.respond
              .acknowledge()
              .then(() => {
                interactionSettled = true;
              })
              .catch(() => undefined);
          }
        },
        reply: async (text) => {
          if (interactionSettled) {
            await ctx.respond.followUp({ text, ephemeral: true });
            return;
          }
          await ctx.respond.reply({ text, ephemeral: true });
          interactionSettled = true;
        },
        editPicker: async (picker) => {
          this.params.api.logger.debug?.(
            `codex discord picker refresh conversation=${conversationId} rows=${picker.buttons?.length ?? 0}`,
          );
          const messageId = ctx.interaction.messageId?.trim();
          const builtPicker = await this.params.tryBuildDiscordPickerMessage(picker);
          let alreadyAcknowledged = false;
          if (builtPicker) {
            try {
              await ctx.respond.editMessage({
                components: builtPicker.components,
              });
              interactionSettled = true;
              if (messageId) {
                await this.params.registerBuiltDiscordComponentMessage({
                  buildResult: builtPicker,
                  messageId,
                });
              }
              return;
            } catch (error) {
              const detail = String(error);
              if (!messageId) {
                this.params.api.logger.warn(
                  `codex discord picker edit failed conversation=${conversationId}: ${detail}`,
                );
              } else if (!detail.includes("already been acknowledged")) {
                await ctx.respond
                  .acknowledge()
                  .then(() => {
                    interactionSettled = true;
                  })
                  .catch(() => undefined);
              } else {
                alreadyAcknowledged = true;
              }
            }
          }
          if (messageId) {
            try {
              if (!interactionSettled && !alreadyAcknowledged) {
                await ctx.respond
                  .acknowledge()
                  .then(() => {
                    interactionSettled = true;
                  })
                  .catch(() => undefined);
              }
              await this.params.editDiscordComponentMessage(
                conversation.conversationId,
                messageId,
                this.params.buildDiscordPickerSpec(picker),
                {
                  accountId: conversation.accountId,
                },
              );
              return;
            } catch (error) {
              this.params.api.logger.warn(
                `codex discord picker edit failed conversation=${conversationId}: ${String(error)}`,
              );
            }
          }
          try {
            await this.params.sendDiscordPicker(conversation, picker);
          } catch (error) {
            this.params.api.logger.warn(
              `codex discord picker send failed conversation=${conversationId}: ${String(error)}`,
            );
            throw error;
          }
        },
        requestConversationBinding: async (params) => {
          const requestConversationBinding = bindingApi.requestConversationBinding;
          if (!requestConversationBinding) {
            return { status: "error", message: "Conversation binding is unavailable." } as const;
          }
          const result = await requestConversationBinding(params);
          if (result.status === "pending") {
            const buttons = this.params.extractReplyButtons(result.reply);
            await this.params.sendDiscordPicker(conversation, {
              text: result.reply.text ?? "Bind approval requested.",
              buttons,
            });
            const originalMessageId = ctx.interaction.messageId?.trim();
            if (callback.kind === "resume-thread" && originalMessageId) {
              await this.params.editDiscordComponentMessage(
                conversation.conversationId,
                originalMessageId,
                {
                  text: "Binding approval requested below.",
                },
                {
                  accountId: conversation.accountId,
                },
              ).catch(() => undefined);
            }
            return result;
          }
          return result;
        },
        detachConversationBinding: bindingApi.detachConversationBinding,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      this.params.api.logger.warn(
        `codex discord interactive failed conversation=${conversationId}: ${detail}`,
      );
      const errorReply = {
        text: "Codex hit an error handling that action. Please retry the command.",
        ephemeral: true,
      } as const;
      const sendError = interactionSettled
        ? ctx.respond.followUp(errorReply)
        : ctx.respond.reply(errorReply);
      await sendError.catch(() => undefined);
    }
  }
}
