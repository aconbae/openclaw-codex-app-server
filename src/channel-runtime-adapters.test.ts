import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./openclaw-types.js";
import {
  OpenClawChannelRuntimeAdapters,
  getLegacyDiscordRuntime,
  getLegacyTelegramRuntime,
} from "./channel-runtime-adapters.js";

function createApiMock(runtimeChannel?: Record<string, unknown>): OpenClawPluginApi {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    runtime: {
      channel: runtimeChannel ?? {},
    },
  } as unknown as OpenClawPluginApi;
}

describe("legacy channel runtime helpers", () => {
  it("reads Telegram and Discord legacy runtimes from the host runtime surface", () => {
    const telegram = { sendMessageTelegram: vi.fn() };
    const discord = { sendMessageDiscord: vi.fn() };
    const api = createApiMock({
      telegram,
      discord,
    });

    expect(getLegacyTelegramRuntime(api)).toBe(telegram);
    expect(getLegacyDiscordRuntime(api)).toBe(discord);
  });
});

describe("OpenClawChannelRuntimeAdapters", () => {
  it("prefers the legacy Telegram token resolver before SDK fallbacks", async () => {
    const loadCompatModule = vi.fn();
    const api = createApiMock({
      telegram: {
        resolveTelegramToken: vi.fn(() => ({ token: "legacy-telegram-token" })),
      },
    });
    const adapters = new OpenClawChannelRuntimeAdapters(
      {
        api,
        getConfig: () => ({}) as any,
      },
      {
        loadCompatModule: loadCompatModule as any,
      },
    );

    await expect(adapters.resolveTelegramBotToken("default")).resolves.toBe(
      "legacy-telegram-token",
    );
    expect(loadCompatModule).not.toHaveBeenCalled();
  });

  it("falls back to the Telegram account SDK when no legacy token is available", async () => {
    const loadCompatModule = vi.fn(async () => ({
      resolveTelegramAccount: vi.fn(() => ({ token: "sdk-telegram-token" })),
    }));
    const adapters = new OpenClawChannelRuntimeAdapters(
      {
        api: createApiMock(),
        getConfig: () => ({}) as any,
      },
      {
        loadCompatModule: loadCompatModule as any,
      },
    );

    await expect(adapters.resolveTelegramBotToken("default")).resolves.toBe(
      "sdk-telegram-token",
    );
    expect(loadCompatModule).toHaveBeenCalledWith(
      expect.objectContaining({
        specifier: "openclaw/plugin-sdk/telegram-account",
      }),
    );
  });

  it("loads Discord runtime API through the host fallback path", async () => {
    const runtimeApi = { sendMessageDiscord: vi.fn() };
    const importModule = vi.fn(async () => runtimeApi);
    const adapters = new OpenClawChannelRuntimeAdapters(
      {
        api: createApiMock(),
        getConfig: () => undefined,
      },
      {
        resolveEntrypointPath: () => "/host/dist/index.js",
        resolveFallbackPath: (_entry, fallbackRelativePath) =>
          `/host/${fallbackRelativePath}`,
        pathExists: (targetPath) => targetPath === "/host/dist/extensions/discord/runtime-api.js",
        importModule,
      },
    );

    await expect(adapters.loadDiscordRuntimeApi()).resolves.toBe(runtimeApi);
    expect(importModule).toHaveBeenCalledWith(
      pathToFileURL("/host/dist/extensions/discord/runtime-api.js").href,
    );
  });

  it("falls back to the Discord extension API when the Discord SDK cannot resolve a token", async () => {
    const loadCompatModule = vi.fn(async () => {
      throw new Error("discord sdk unavailable");
    });
    const importModule = vi.fn(async () => ({
      resolveDiscordAccount: vi.fn(() => ({ token: "extension-discord-token" })),
    }));
    const adapters = new OpenClawChannelRuntimeAdapters(
      {
        api: createApiMock(),
        getConfig: () => ({}) as any,
      },
      {
        loadCompatModule: loadCompatModule as any,
        resolveEntrypointPath: () => "/host/dist/index.js",
        resolveFallbackPath: (_entry, fallbackRelativePath) =>
          `/host/${fallbackRelativePath}`,
        pathExists: (targetPath) => targetPath === "/host/dist/extensions/discord/api.js",
        importModule,
      },
    );

    await expect(adapters.resolveDiscordBotToken("default")).resolves.toBe(
      "extension-discord-token",
    );
    expect(importModule).toHaveBeenCalledWith(
      pathToFileURL("/host/dist/extensions/discord/api.js").href,
    );
  });
});
