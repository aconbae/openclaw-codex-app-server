import type {
  OpenClawPluginApi as HostOpenClawPluginApi,
  OpenClawPluginService,
  PluginCommandContext as HostPluginCommandContext,
  PluginLogger as HostPluginLogger,
  ReplyPayload,
} from "openclaw/plugin-sdk/core";
import type { ConversationRef } from "openclaw/plugin-sdk/conversation-runtime";
import type {
  PluginConversationBinding,
  PluginConversationBindingRequestResult,
} from "openclaw/plugin-sdk/plugin-runtime";
import type {
  DiscordInteractiveHandlerContext as HostDiscordInteractiveHandlerContext,
} from "../node_modules/openclaw/dist/plugin-sdk/extensions/discord/contract-api.js";
import type { MediaAttachment as HostMediaAttachment } from "../node_modules/openclaw/dist/plugin-sdk/src/media-understanding/types.js";
import type {
  TelegramInteractiveHandlerContext as HostTelegramInteractiveHandlerContext,
} from "../node_modules/openclaw/dist/plugin-sdk/extensions/telegram/contract-api.js";

export type {
  ConversationRef,
  OpenClawPluginService,
  PluginConversationBinding,
  PluginConversationBindingRequestResult,
  ReplyPayload,
};

export type PluginLogger = {
  info: NonNullable<HostPluginLogger["info"]>;
  warn: NonNullable<HostPluginLogger["warn"]>;
  error: NonNullable<HostPluginLogger["error"]>;
  debug: NonNullable<HostPluginLogger["debug"]>;
};

export type PluginCommandContext = HostPluginCommandContext;

export type OpenClawPluginApi = Omit<HostOpenClawPluginApi, "logger"> & {
  logger: PluginLogger;
};

export type PluginConversationBindingResolvedEvent =
  Parameters<OpenClawPluginApi["onConversationBindingResolved"]>[0] extends (
    event: infer TEvent,
  ) => void | Promise<void>
    ? TEvent
    : never;

export type PluginInboundMedia = HostMediaAttachment;

export type PluginInteractiveButtons = NonNullable<
  Parameters<HostTelegramInteractiveHandlerContext["respond"]["reply"]>[0]["buttons"]
>;

export type PluginInteractiveTelegramHandlerContext = HostTelegramInteractiveHandlerContext;

export type PluginInteractiveDiscordHandlerContext = HostDiscordInteractiveHandlerContext;
