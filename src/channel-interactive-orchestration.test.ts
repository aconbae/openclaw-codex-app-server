import { describe, expect, it, vi } from "vitest";
import {
  OpenClawChannelInteractiveOrchestration,
} from "./channel-interactive-orchestration.js";
import type {
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveTelegramHandlerContext,
  ReplyPayload,
} from "./openclaw-types.js";
import type { OpenClawPluginApi, PluginInteractiveButtons } from "./openclaw-types.js";
import type { DiscordComponentBuildResult } from "./discord-component-types.js";

function createApiMock(): OpenClawPluginApi {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as OpenClawPluginApi;
}

function extractReplyButtons(reply: ReplyPayload): PluginInteractiveButtons | undefined {
  return (reply.channelData as { telegram?: { buttons?: PluginInteractiveButtons } } | undefined)
    ?.telegram?.buttons;
}

function createHarness() {
  const api = createApiMock();
  const getCallback = vi.fn();
  const dispatchCallbackAction = vi.fn(async (..._args: unknown[]) => {});
  const tryBuildDiscordPickerMessage = vi.fn(
    async (picker: { text: string }) =>
      ({
        components: [picker.text],
        entries: [{ id: "entry-1", kind: "button", label: "Tap" }],
        modals: [],
      }) satisfies DiscordComponentBuildResult,
  );
  const registerBuiltDiscordComponentMessage = vi.fn(async () => {});
  const editDiscordComponentMessage = vi.fn(async () => ({
    messageId: "message-1",
    channelId: "channel:chan-1",
  }));
  const sendDiscordPicker = vi.fn(async () => {});
  const orchestration = new OpenClawChannelInteractiveOrchestration({
    api,
    getCallback,
    dispatchCallbackAction,
    normalizeDiscordConversationId: (raw) => raw,
    normalizeDiscordInteractiveConversationId: ({ conversationId }) => conversationId,
    extractReplyButtons,
    buildDiscordPickerSpec: (picker) => ({
      text: picker.text,
      blocks: (picker.buttons ?? []).map((row) => ({
        type: "actions" as const,
        buttons: row.map((button) => ({
          label: button.text,
          style: "primary" as const,
          callbackData: button.callback_data,
        })),
      })),
    }),
    tryBuildDiscordPickerMessage,
    registerBuiltDiscordComponentMessage,
    editDiscordComponentMessage,
    sendDiscordPicker,
  });
  return {
    api,
    orchestration,
    getCallback,
    dispatchCallbackAction,
    tryBuildDiscordPickerMessage,
    registerBuiltDiscordComponentMessage,
    editDiscordComponentMessage,
    sendDiscordPicker,
  };
}

describe("OpenClawChannelInteractiveOrchestration", () => {
  it("replies when a Telegram callback token is expired", async () => {
    const { orchestration, getCallback, dispatchCallbackAction } = createHarness();
    getCallback.mockReturnValue(undefined);
    const reply = vi.fn(async () => {});

    await orchestration.handleTelegramInteractive({
      accountId: "default",
      conversationId: "123",
      callback: {
        payload: "expired-token",
      },
      respond: {
        reply,
        clearButtons: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as unknown as PluginInteractiveTelegramHandlerContext);

    expect(reply).toHaveBeenCalledWith({
      text: "That Codex action expired. Please retry the command.",
    });
    expect(dispatchCallbackAction).not.toHaveBeenCalled();
  });

  it("forwards Telegram pending bind replies with extracted buttons", async () => {
    const { orchestration, getCallback, dispatchCallbackAction } = createHarness();
    getCallback.mockReturnValue({
      kind: "resume-thread",
      token: "token-1",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      syncTopic: false,
      notifyBound: true,
    });
    const reply = vi.fn(async () => {});
    const requestConversationBinding = vi.fn(async () => ({
      status: "pending" as const,
      reply: {
        text: "Plugin bind approval required",
        channelData: {
          telegram: {
            buttons: [[{ text: "Approve", callback_data: "codexapp:approve" }]],
          },
        },
      },
    }));
    dispatchCallbackAction.mockImplementation(async (...args: unknown[]) => {
      const responders = args[1] as { requestConversationBinding?: () => Promise<unknown> };
      await responders.requestConversationBinding?.();
    });

    await orchestration.handleTelegramInteractive({
      accountId: "default",
      conversationId: "123",
      callback: {
        payload: "token-1",
      },
      requestConversationBinding,
      respond: {
        reply,
        clearButtons: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as unknown as PluginInteractiveTelegramHandlerContext);

    expect(requestConversationBinding).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      text: "Plugin bind approval required",
      buttons: [[{ text: "Approve", callback_data: "codexapp:approve" }]],
    });
  });

  it("refreshes Discord pickers by editing the original interaction message", async () => {
    const {
      orchestration,
      getCallback,
      dispatchCallbackAction,
      registerBuiltDiscordComponentMessage,
      editDiscordComponentMessage,
      sendDiscordPicker,
    } = createHarness();
    getCallback.mockReturnValue({
      kind: "picker-view",
      token: "token-1",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      view: {
        mode: "projects",
        includeAll: true,
        page: 0,
      },
    });
    dispatchCallbackAction.mockImplementation(async (...args: unknown[]) => {
      const responders = args[1] as {
        editPicker: (picker: { text: string; buttons: PluginInteractiveButtons | undefined }) => Promise<void>;
      };
      await responders.editPicker({
        text: "Choose a project",
        buttons: undefined,
      });
    });
    const editMessage = vi.fn(async () => {});

    await orchestration.handleDiscordInteractive({
      accountId: "default",
      conversationId: "channel:chan-1",
      interaction: {
        payload: "token-1",
        messageId: "message-1",
      },
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage,
        clearComponents: vi.fn(async () => {}),
      },
    } as unknown as PluginInteractiveDiscordHandlerContext);

    expect(editMessage).toHaveBeenCalledWith({
      components: ["Choose a project"],
    });
    expect(registerBuiltDiscordComponentMessage).toHaveBeenCalledWith({
      buildResult: expect.objectContaining({
        components: ["Choose a project"],
      }),
      messageId: "message-1",
    });
    expect(editDiscordComponentMessage).not.toHaveBeenCalled();
    expect(sendDiscordPicker).not.toHaveBeenCalled();
  });

  it("falls back to direct Discord message edit when the interaction was already acknowledged", async () => {
    const {
      orchestration,
      getCallback,
      dispatchCallbackAction,
      registerBuiltDiscordComponentMessage,
      editDiscordComponentMessage,
      sendDiscordPicker,
    } = createHarness();
    getCallback.mockReturnValue({
      kind: "picker-view",
      token: "token-1",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      view: {
        mode: "projects",
        includeAll: true,
        page: 0,
      },
    });
    dispatchCallbackAction.mockImplementation(async (...args: unknown[]) => {
      const responders = args[1] as {
        editPicker: (picker: { text: string; buttons: PluginInteractiveButtons | undefined }) => Promise<void>;
      };
      await responders.editPicker({
        text: "Choose a project",
        buttons: undefined,
      });
    });
    const editMessage = vi.fn(async () => {
      throw new Error("Interaction has already been acknowledged.");
    });

    await orchestration.handleDiscordInteractive({
      accountId: "default",
      conversationId: "channel:chan-1",
      interaction: {
        payload: "token-1",
        messageId: "message-1",
      },
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage,
        clearComponents: vi.fn(async () => {}),
      },
    } as unknown as PluginInteractiveDiscordHandlerContext);

    expect(editMessage).toHaveBeenCalled();
    expect(registerBuiltDiscordComponentMessage).not.toHaveBeenCalled();
    expect(editDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      "message-1",
      expect.objectContaining({
        text: "Choose a project",
      }),
      expect.objectContaining({
        accountId: "default",
      }),
    );
    expect(sendDiscordPicker).not.toHaveBeenCalled();
  });
});
