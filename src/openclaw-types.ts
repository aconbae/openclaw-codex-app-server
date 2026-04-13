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
  PluginConversationBindingResolvedEvent,
} from "openclaw/plugin-sdk/plugin-runtime";
import type {
  PluginInboundMedia,
  PluginInteractiveButtons,
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveTelegramHandlerContext,
} from "./openclaw-host-types.js";

export type {
  ConversationRef,
  OpenClawPluginService,
  PluginConversationBinding,
  PluginConversationBindingRequestResult,
  PluginConversationBindingResolvedEvent,
  PluginInboundMedia,
  PluginInteractiveButtons,
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveTelegramHandlerContext,
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
