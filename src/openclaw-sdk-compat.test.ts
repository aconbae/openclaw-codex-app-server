import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  isMissingPluginSdkSubpathError,
  loadOpenClawCompatModule,
  resolveCompatFallbackPath,
  resolveOpenClawEntrypointPath,
} from "./openclaw-sdk-compat.js";

const require = createRequire(import.meta.url);

describe("openclaw sdk compat", () => {
  it("detects removed plugin sdk subpath exports", () => {
    const error = Object.assign(
      new Error('Package subpath "./plugin-sdk/discord" is not defined by "exports"'),
      {
        code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
      },
    );

    expect(isMissingPluginSdkSubpathError(error, "openclaw/plugin-sdk/discord")).toBe(true);
  });

  it("detects missing plugin sdk subpaths from object-like jiti errors", () => {
    expect(
      isMissingPluginSdkSubpathError(
        {
          message:
            "Cannot find module '/Users/huntharo/github/openclaw/dist/plugin-sdk/root-alias.cjs/discord'",
        },
        "openclaw/plugin-sdk/discord",
      ),
    ).toBe(true);
  });

  it("resolves fallback paths from the OpenClaw entrypoint", () => {
    expect(
      resolveCompatFallbackPath(
        "/tmp/node_modules/openclaw/dist/index.js",
        "dist/plugin-sdk/discord.js",
      ),
    ).toBe("/tmp/node_modules/openclaw/dist/plugin-sdk/discord.js");
  });

  it("falls back to the dist facade when the public subpath is gone", async () => {
    const importer = vi.fn(async (specifier: string) => {
      if (specifier === "openclaw/plugin-sdk/discord") {
        throw Object.assign(
          new Error('Package subpath "./plugin-sdk/discord" is not defined by "exports"'),
          {
            code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
          },
        );
      }
      return { ok: true, specifier };
    });

    const result = await loadOpenClawCompatModule<{ ok: boolean; specifier: string }>({
      specifier: "openclaw/plugin-sdk/discord",
      fallbackRelativePath: "dist/extensions/discord/api.js",
      label: "discord",
      importer,
      resolver: () => "/tmp/node_modules/openclaw/dist/index.js",
      pathExists: () => true,
      cache: new Map(),
    });

    expect(result).toEqual({
      ok: true,
      specifier: "file:///tmp/node_modules/openclaw/dist/extensions/discord/api.js",
    });
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("prefers the host OpenClaw checkout from argv/cwd over the local dependency", () => {
    const files = new Map<string, string>([
      [
        "/host/openclaw/package.json",
        JSON.stringify({
          name: "openclaw",
          exports: {
            "./plugin-sdk": { default: "./dist/plugin-sdk/index.js" },
            "./cli-entry": { default: "./dist/cli-entry.js" },
          },
        }),
      ],
    ]);

    const result = resolveOpenClawEntrypointPath({
      argv1: "/host/openclaw/openclaw.mjs",
      cwd: "/host/openclaw",
      pathExists: (targetPath) =>
        targetPath === "/host/openclaw/openclaw.mjs" ||
        targetPath === "/host/openclaw/dist/index.js" ||
        files.has(targetPath),
      readFile: (targetPath) => {
        const content = files.get(targetPath);
        if (!content) {
          throw new Error(`missing ${targetPath}`);
        }
        return content;
      },
      resolver: () => "/repo/openclaw-app-server/node_modules/openclaw/dist/index.js",
    });

    expect(result).toBe("/host/openclaw/dist/index.js");
  });

  it("rethrows non-resolution failures from the public import", async () => {
    const importer = vi.fn(async (_specifier: string) => {
      throw new Error("boom");
    });

    await expect(
      loadOpenClawCompatModule({
        specifier: "openclaw/plugin-sdk/discord",
        fallbackRelativePath: "dist/extensions/discord/api.js",
        label: "discord",
        importer,
        resolver: () => "/tmp/node_modules/openclaw/dist/index.js",
        pathExists: () => true,
        cache: new Map(),
      }),
    ).rejects.toThrow("boom");
  });

  it("resolves the published host entry points used by this repo", () => {
    expect(require.resolve("openclaw/plugin-sdk/core")).toContain("/openclaw/");
    expect(require.resolve("openclaw/plugin-sdk/channel-contract")).toContain("/openclaw/");
    expect(require.resolve("openclaw/plugin-sdk/conversation-runtime")).toContain("/openclaw/");
    expect(require.resolve("openclaw/plugin-sdk/plugin-runtime")).toContain("/openclaw/");
  });

  it("keeps the required compat fallback files on the installed host", () => {
    const entrypointPath = resolveOpenClawEntrypointPath();
    const requiredFallbacks = [
      "dist/extensions/discord/api.js",
      "dist/extensions/discord/runtime-api.js",
      "dist/extensions/telegram/api.js",
      "dist/extensions/telegram/runtime-api.js",
    ];

    for (const fallbackRelativePath of requiredFallbacks) {
      expect(fs.existsSync(resolveCompatFallbackPath(entrypointPath, fallbackRelativePath))).toBe(
        true,
      );
    }
  });

  it("exposes the required compat fallback exports on the installed host", async () => {
    const entrypointPath = resolveOpenClawEntrypointPath();
    const requiredModules = [
      {
        fallbackRelativePath: "dist/extensions/discord/api.js",
        requiredExports: ["buildDiscordComponentMessage", "resolveDiscordAccount"],
      },
      {
        fallbackRelativePath: "dist/extensions/discord/runtime-api.js",
        requiredExports: [
          "editChannelDiscord",
          "editDiscordComponentMessage",
          "pinMessageDiscord",
          "registerBuiltDiscordComponentMessage",
          "sendDiscordComponentMessage",
          "sendMessageDiscord",
          "sendTypingDiscord",
          "unpinMessageDiscord",
        ],
      },
      {
        fallbackRelativePath: "dist/extensions/telegram/api.js",
        requiredExports: ["resolveTelegramAccount"],
      },
      {
        fallbackRelativePath: "dist/extensions/telegram/runtime-api.js",
        requiredExports: [
          "editMessageTelegram",
          "pinMessageTelegram",
          "renameForumTopicTelegram",
          "sendMessageTelegram",
          "sendTypingTelegram",
          "unpinMessageTelegram",
        ],
      },
    ];

    for (const moduleSpec of requiredModules) {
      const modulePath = resolveCompatFallbackPath(entrypointPath, moduleSpec.fallbackRelativePath);
      const moduleUrl = pathToFileURL(path.resolve(modulePath)).href;
      const loaded = (await import(moduleUrl)) as Record<string, unknown>;
      for (const exportName of moduleSpec.requiredExports) {
        expect(typeof loaded[exportName], `${moduleSpec.fallbackRelativePath} -> ${exportName}`).toBe(
          "function",
        );
      }
    }
  });

  it("parses the repo-supported Discord component helper spec on the installed host", async () => {
    const entrypointPath = resolveOpenClawEntrypointPath();
    const modulePath = resolveCompatFallbackPath(entrypointPath, "dist/extensions/discord/api.js");
    const moduleUrl = pathToFileURL(path.resolve(modulePath)).href;
    const loaded = (await import(moduleUrl)) as {
      buildDiscordComponentMessage: (params: {
        spec: Record<string, unknown>;
        fallbackText?: string;
      }) => {
        components: unknown[];
        entries: Array<{ kind?: string; label?: string; callbackData?: string; modalId?: string }>;
        modals: Array<{ title?: string; callbackData?: string; fields?: unknown[] }>;
      };
    };

    const buildResult = loaded.buildDiscordComponentMessage({
      spec: {
        text: "Hello",
        blocks: [
          {
            type: "actions",
            buttons: [{ label: "Pick", callbackData: "pick" }],
          },
        ],
        modal: {
          title: "Reason",
          callbackData: "reason",
          triggerLabel: "Open",
          fields: [{ type: "text", label: "Why?", required: true }],
        },
      },
      fallbackText: "Hello",
    });

    expect(Array.isArray(buildResult.components)).toBe(true);
    expect(buildResult.components.length).toBeGreaterThan(0);
    expect(buildResult.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "button",
          label: "Pick",
          callbackData: "pick",
        }),
        expect.objectContaining({
          kind: "modal-trigger",
          label: "Open",
        }),
      ]),
    );
    expect(buildResult.modals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Reason",
          callbackData: "reason",
          fields: expect.arrayContaining([
            expect.objectContaining({
              label: "Why?",
              type: "text",
            }),
          ]),
        }),
      ]),
    );
  });
});
