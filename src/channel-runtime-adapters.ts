import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig as HostOpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { OpenClawPluginApi, PluginInteractiveButtons } from "./openclaw-types.js";
import type {
  DiscordComponentBuildResult,
  DiscordComponentMessageSpec,
} from "./discord-component-types.js";
import {
  loadOpenClawCompatModule,
  type PluginSdkCompatLogger,
  resolveCompatFallbackPath,
  resolveOpenClawEntrypointPath,
} from "./openclaw-sdk-compat.js";

export type DiscordComponentMessageSendResult = {
  messageId: string;
  channelId: string;
};

export type DiscordChannelEditPayload = {
  channelId: string;
  name?: string;
  topic?: string;
  position?: number;
  parentId?: string | null;
  nsfw?: boolean;
  rateLimitPerUser?: number;
  archived?: boolean;
  locked?: boolean;
  autoArchiveDuration?: number;
  availableTags?: Array<{
    id?: string;
    name: string;
    moderated?: boolean;
    emoji_id?: string | null;
    emoji_name?: string | null;
  }>;
};

export type DiscordChannelEditResult = {
  id?: string;
  name?: string;
};

export type DiscordAccountResolution = {
  token: string;
};

export type TelegramAccountResolution = {
  token: string;
};

export type TelegramTokenResolution = {
  token?: string;
};

export type DiscordSendOpts = {
  cfg?: HostOpenClawConfig;
  accountId?: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  [key: string]: unknown;
};

export type TelegramSendOpts = {
  cfg?: HostOpenClawConfig;
  token?: string;
  accountId?: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  messageThreadId?: number;
  buttons?: PluginInteractiveButtons;
  [key: string]: unknown;
};

export type TelegramEditOpts = {
  cfg?: HostOpenClawConfig;
  accountId?: string;
  buttons?: PluginInteractiveButtons;
  [key: string]: unknown;
};

export type DiscordResolveAccount = (params: {
  cfg: HostOpenClawConfig;
  accountId?: string | null;
}) => DiscordAccountResolution;

export type TelegramResolveAccount = (params: {
  cfg: HostOpenClawConfig;
  accountId?: string | null;
}) => TelegramAccountResolution;

export type TelegramResolveToken = (
  cfg?: HostOpenClawConfig,
  opts?: { accountId?: string | null; [key: string]: unknown },
) => TelegramTokenResolution;

export type DiscordSendMessage = (
  to: string,
  text: string,
  opts?: DiscordSendOpts,
) => Promise<DiscordComponentMessageSendResult>;

export type DiscordSendTyping = (
  channelId: string,
  opts?: { cfg?: HostOpenClawConfig; accountId?: string; [key: string]: unknown },
) => Promise<unknown>;

export type DiscordPinMessage = (
  channelId: string,
  messageId: string,
  opts?: { cfg?: HostOpenClawConfig; accountId?: string; [key: string]: unknown },
) => Promise<unknown>;

export type DiscordEditChannel = (
  payload: DiscordChannelEditPayload,
  opts?: { cfg?: HostOpenClawConfig; accountId?: string; [key: string]: unknown },
) => Promise<DiscordChannelEditResult>;

export type TelegramSendMessage = (
  to: string,
  text: string,
  opts?: TelegramSendOpts,
) => Promise<{ messageId: string; chatId: string }>;

export type TelegramSendTyping = (
  to: string,
  opts?: {
    cfg?: HostOpenClawConfig;
    accountId?: string;
    messageThreadId?: number;
    [key: string]: unknown;
  },
) => Promise<unknown>;

export type TelegramPinMessage = (
  chatId: string | number,
  messageId: string | number,
  opts?: { cfg?: HostOpenClawConfig; accountId?: string; [key: string]: unknown },
) => Promise<unknown>;

export type TelegramUnpinMessage = (
  chatId: string | number,
  messageId?: string | number,
  opts?: { cfg?: HostOpenClawConfig; accountId?: string; [key: string]: unknown },
) => Promise<unknown>;

export type TelegramEditMessage = (
  chatId: string | number,
  messageId: string | number,
  text: string,
  opts?: TelegramEditOpts,
) => Promise<unknown>;

export type TelegramRenameTopic = (
  chatId: string | number,
  messageThreadId: string | number,
  name: string,
  opts?: { cfg?: HostOpenClawConfig; accountId?: string; [key: string]: unknown },
) => Promise<unknown>;

export type DiscordSdkModule = {
  resolveDiscordAccount: DiscordResolveAccount;
  buildDiscordComponentMessage: (params: {
    spec: DiscordComponentMessageSpec;
    fallbackText?: string;
    sessionKey?: string;
    agentId?: string;
    accountId?: string;
  }) => DiscordComponentBuildResult;
  editDiscordComponentMessage?: (
    to: string,
    messageId: string,
    spec: DiscordComponentMessageSpec,
    opts?: { accountId?: string },
  ) => Promise<DiscordComponentMessageSendResult>;
  registerBuiltDiscordComponentMessage?: (params: {
    buildResult: DiscordComponentBuildResult;
    messageId: string;
  }) => void;
};

export type TelegramAccountSdkModule = {
  resolveTelegramAccount: TelegramResolveAccount;
};

export type DiscordExtensionApiModule = Partial<{
  resolveDiscordAccount: DiscordResolveAccount;
}>;

export type DiscordRuntimeApiModule = {
  editDiscordComponentMessage?: (
    to: string,
    messageId: string,
    spec: DiscordComponentMessageSpec,
    opts?: {
      cfg?: unknown;
      accountId?: string;
    },
  ) => Promise<DiscordComponentMessageSendResult>;
  registerBuiltDiscordComponentMessage?: (params: {
    buildResult: DiscordComponentBuildResult;
    messageId: string;
  }) => void;
  sendDiscordComponentMessage?: (
    to: string,
    spec: DiscordComponentMessageSpec,
    opts?: {
      cfg?: unknown;
      accountId?: string;
      mediaUrl?: string;
      mediaLocalRoots?: readonly string[];
    },
  ) => Promise<DiscordComponentMessageSendResult>;
  sendMessageDiscord?: DiscordSendMessage;
  sendTypingDiscord?: DiscordSendTyping;
  pinMessageDiscord?: DiscordPinMessage;
  unpinMessageDiscord?: DiscordPinMessage;
  editChannelDiscord?: DiscordEditChannel;
};

export type TelegramRuntimeApiModule = {
  sendMessageTelegram?: TelegramSendMessage;
  sendTypingTelegram?: TelegramSendTyping;
  pinMessageTelegram?: TelegramPinMessage;
  unpinMessageTelegram?: TelegramUnpinMessage;
  editMessageTelegram?: TelegramEditMessage;
  renameForumTopicTelegram?: TelegramRenameTopic;
};

export type LegacyTelegramRuntime = {
  sendMessageTelegram?: TelegramSendMessage;
  resolveTelegramToken?: TelegramResolveToken;
  typing?: {
    start?: (params: {
      to: string;
      accountId?: string;
      messageThreadId?: number;
    }) => Promise<{
      refresh: () => Promise<void>;
      stop: () => void;
    }>;
  };
  conversationActions?: {
    renameTopic?: TelegramRenameTopic;
  };
};

export type LegacyDiscordRuntime = {
  sendMessageDiscord?: DiscordSendMessage;
  sendComponentMessage?: (
    to: string,
    spec: DiscordComponentMessageSpec,
    opts?: { accountId?: string },
  ) => Promise<DiscordComponentMessageSendResult>;
  typing?: {
    start?: (params: {
      channelId: string;
      accountId?: string;
    }) => Promise<{
      refresh: () => Promise<void>;
      stop: () => void;
    }>;
  };
  conversationActions?: {
    editChannel?: (
      channelId: string,
      params: { name?: string },
      opts?: { accountId?: string },
    ) => Promise<DiscordChannelEditResult>;
  };
};

type CompatModuleLoader = <T>(params: {
  specifier: string;
  fallbackRelativePath: string;
  label: string;
  logger?: PluginSdkCompatLogger;
}) => Promise<T>;

export type ChannelRuntimeAdapterDeps = {
  loadCompatModule?: CompatModuleLoader;
  resolveEntrypointPath?: () => string;
  resolveFallbackPath?: (openClawEntrypointPath: string, fallbackRelativePath: string) => string;
  pathExists?: (targetPath: string) => boolean;
  importModule?: (specifier: string) => Promise<unknown>;
};

export function getLegacyTelegramRuntime(
  api: OpenClawPluginApi,
): LegacyTelegramRuntime | undefined {
  return (api.runtime.channel as { telegram?: LegacyTelegramRuntime }).telegram;
}

export function getLegacyDiscordRuntime(
  api: OpenClawPluginApi,
): LegacyDiscordRuntime | undefined {
  return (api.runtime.channel as { discord?: LegacyDiscordRuntime }).discord;
}

export class OpenClawChannelRuntimeAdapters {
  private readonly deps: Required<ChannelRuntimeAdapterDeps>;

  constructor(
    private readonly params: {
      api: OpenClawPluginApi;
      getConfig: () => HostOpenClawConfig | undefined;
    },
    deps?: ChannelRuntimeAdapterDeps,
  ) {
    this.deps = {
      loadCompatModule: deps?.loadCompatModule ?? loadOpenClawCompatModule,
      resolveEntrypointPath: deps?.resolveEntrypointPath ?? (() => resolveOpenClawEntrypointPath()),
      resolveFallbackPath: deps?.resolveFallbackPath ?? resolveCompatFallbackPath,
      pathExists: deps?.pathExists ?? existsSync,
      importModule: deps?.importModule ?? (async (specifier: string) => await import(specifier)),
    };
  }

  async loadDiscordSdk(): Promise<DiscordSdkModule> {
    return await this.deps.loadCompatModule<DiscordSdkModule>({
      specifier: "openclaw/plugin-sdk/discord",
      fallbackRelativePath: "dist/extensions/discord/api.js",
      label: "discord",
      logger: this.params.api.logger,
    });
  }

  async loadTelegramAccountSdk(): Promise<TelegramAccountSdkModule> {
    return await this.deps.loadCompatModule<TelegramAccountSdkModule>({
      specifier: "openclaw/plugin-sdk/telegram-account",
      fallbackRelativePath: "dist/extensions/telegram/api.js",
      label: "telegram account",
      logger: this.params.api.logger,
    });
  }

  async loadDiscordRuntimeApi(): Promise<DiscordRuntimeApiModule | undefined> {
    return await this.loadFallbackModule<DiscordRuntimeApiModule>(
      "discord runtime api",
      "dist/extensions/discord/runtime-api.js",
    );
  }

  async loadTelegramRuntimeApi(): Promise<TelegramRuntimeApiModule | undefined> {
    return await this.loadFallbackModule<TelegramRuntimeApiModule>(
      "telegram runtime api",
      "dist/extensions/telegram/runtime-api.js",
    );
  }

  async loadDiscordExtensionApi(): Promise<DiscordExtensionApiModule | undefined> {
    return await this.loadFallbackModule<DiscordExtensionApiModule>(
      "discord extension api",
      "dist/extensions/discord/api.js",
    );
  }

  async resolveTelegramBotToken(accountId?: string): Promise<string | undefined> {
    const legacyResolution = getLegacyTelegramRuntime(this.params.api)?.resolveTelegramToken?.(
      this.params.getConfig(),
      { accountId },
    );
    const legacyToken = legacyResolution?.token?.trim();
    if (legacyToken) {
      return legacyToken;
    }
    const cfg = this.params.getConfig();
    if (!cfg) {
      return undefined;
    }
    try {
      const telegramAccount = await this.loadTelegramAccountSdk();
      const account = telegramAccount.resolveTelegramAccount({
        cfg,
        accountId,
      });
      const token = account?.token?.trim();
      return token || undefined;
    } catch (error) {
      this.params.api.logger.debug?.(`codex telegram account facade unavailable: ${String(error)}`);
      return undefined;
    }
  }

  async resolveDiscordBotToken(accountId?: string): Promise<string | undefined> {
    const cfg = this.params.getConfig();
    if (!cfg) {
      return undefined;
    }
    try {
      const discordSdk = await this.loadDiscordSdk();
      const account = discordSdk.resolveDiscordAccount({
        cfg,
        accountId,
      });
      const token = account.token?.trim();
      if (token) {
        return token;
      }
    } catch (error) {
      this.params.api.logger.debug?.(`codex discord account facade unavailable: ${String(error)}`);
    }
    const discordApi = await this.loadDiscordExtensionApi();
    const account = discordApi?.resolveDiscordAccount?.({
      cfg,
      accountId,
    });
    const token = account?.token?.trim();
    return token || undefined;
  }

  private async loadFallbackModule<T>(
    label: string,
    fallbackRelativePath: string,
  ): Promise<T | undefined> {
    try {
      const openClawEntrypointPath = this.deps.resolveEntrypointPath();
      const fallbackPath = this.deps.resolveFallbackPath(
        openClawEntrypointPath,
        fallbackRelativePath,
      );
      if (!this.deps.pathExists(fallbackPath)) {
        return undefined;
      }
      return (await this.deps.importModule(pathToFileURL(fallbackPath).href)) as T;
    } catch (error) {
      this.params.api.logger.debug?.(`codex ${label} unavailable: ${String(error)}`);
      return undefined;
    }
  }
}
