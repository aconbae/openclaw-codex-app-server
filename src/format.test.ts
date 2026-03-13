import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatBoundThreadSummary,
  formatCodexStatusText,
  formatThreadPickerIntro,
  formatThreadButtonLabel,
} from "./format.js";

describe("formatThreadButtonLabel", () => {
  it("uses worktree and age badges while keeping the project suffix at the end", () => {
    expect(
      formatThreadButtonLabel({
        thread: {
          threadId: "019cdaf5-54be-7ba2-b610-dd71b0efb42b",
          title: "App Server Redux - Plugin Surface Build",
          projectKey: "/Users/huntharo/.codex/worktrees/cb00/openclaw",
          updatedAt: Date.now() - 4 * 60_000,
          createdAt: Date.now() - 10 * 60 * 60_000,
        },
        includeProjectSuffix: true,
        isWorktree: true,
        hasChanges: true,
      }),
    ).toContain("🌿 ✏️ App Server Redux - Plugin Surface Build (openclaw) U:4m C:10h");
  });

  it("falls back to the final workspace segment for non-worktree paths", () => {
    expect(
      formatThreadButtonLabel({
        thread: {
          threadId: "019cbef1-376b-7312-98aa-24488c7499d4",
          projectKey: "/Users/huntharo/.openclaw/workspace",
        },
        includeProjectSuffix: true,
      }),
    ).toBe("019cbef1-376b-7312-98aa-24488c7499d4 (workspace)");
  });
});

describe("formatBoundThreadSummary", () => {
  it("includes project, thread metadata, and replay context", () => {
    expect(
      formatBoundThreadSummary({
        binding: {
          conversation: {
            channel: "telegram",
            accountId: "default",
            conversationId: "chat-1",
          },
          sessionKey: "openclaw-app-server:thread:abc",
          threadId: "019cc00d-6cf4-7c11-afcd-2673db349a21",
          workspaceDir: "/Users/huntharo/.codex/worktrees/41fb/openclaw",
          threadTitle: "Fix Telegram approval flow",
          updatedAt: 1,
        },
        state: {
          threadId: "019cc00d-6cf4-7c11-afcd-2673db349a21",
          threadName: "Fix Telegram approval flow",
          cwd: "/Users/huntharo/.codex/worktrees/41fb/openclaw",
        },
      }),
    ).toBe(
      [
        "Codex thread bound.",
        "Project: openclaw",
        "Thread Name: Fix Telegram approval flow",
        "Thread ID: 019cc00d-6cf4-7c11-afcd-2673db349a21",
        "Worktree Path: /Users/huntharo/.codex/worktrees/41fb/openclaw",
      ].join("\n"),
    );
  });
});

describe("formatCodexStatusText", () => {
  it("matches the old operational Codex status shape", () => {
    const text = formatCodexStatusText({
      bindingActive: true,
      threadState: {
        threadId: "019cc00d-6cf4-7c11-afcd-2673db349a21",
        threadName: "Fix Telegram approval flow",
        model: "gpt-5.4",
        modelProvider: "openai",
        reasoningEffort: "high",
        serviceTier: "default",
        cwd: "/Users/huntharo/.codex/worktrees/41fb/openclaw",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      account: {
        type: "chatgpt",
        email: "huntharo@gmail.com",
        planType: "pro",
      },
      projectFolder: "/Users/huntharo/github/openclaw",
      worktreeFolder: "/Users/huntharo/.codex/worktrees/41fb/openclaw",
      rateLimits: [
        {
          name: "5h limit",
          usedPercent: 15,
          resetAt: new Date("2026-03-13T10:03:00-04:00").getTime(),
          windowSeconds: 18_000,
        },
        {
          name: "Weekly limit",
          usedPercent: 15,
          resetAt: new Date("2026-03-14T10:03:00-04:00").getTime(),
          windowSeconds: 604_800,
        },
      ],
    });

    expect(text).toContain("OpenAI Codex");
    expect(text).toContain("Binding: active");
    expect(text).toContain("Thread: Fix Telegram approval flow");
    expect(text).toContain("Model: openai/gpt-5.4 · reasoning high");
    expect(text).toContain("Project folder: ~/github/openclaw");
    expect(text).toContain("Worktree folder: ~/.codex/worktrees/41fb/openclaw");
    expect(text).toContain("Fast mode: off");
    expect(text).toContain("Context usage: unavailable until Codex emits a token-usage update");
    expect(text).toContain("Permissions: Default");
    expect(text).toContain("Account: huntharo@gmail.com (pro)");
    expect(text).toContain("Session: 019cc00d-6cf4-7c11-afcd-2673db349a21");
    expect(text).toContain("Rate limits timezone:");
    expect(text).toContain("5h limit: 85% left");
    expect(text).toContain("Weekly limit: 85% left");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats context usage once a fresh token snapshot exists", () => {
    const text = formatCodexStatusText({
      bindingActive: true,
      threadState: {
        threadId: "thread-123",
        threadName: "Plan TASKS doc refresh",
        model: "gpt-5.4",
        modelProvider: "openai",
        reasoningEffort: "high",
        cwd: "/repo/openclaw",
      },
      account: {
        type: "chatgpt",
        email: "user@example.com",
        planType: "pro",
      },
      projectFolder: "/repo/openclaw",
      worktreeFolder: "/repo/openclaw",
      contextUsage: {
        totalTokens: 139_000,
        contextWindow: 258_000,
      },
      rateLimits: [
        {
          name: "5h limit",
          usedPercent: 4,
        },
      ],
    });

    expect(text).toContain("Context usage: 139k / 258k tokens used (54% full)");
  });

  it("does not render a partial context usage line when only the window size is known", () => {
    const text = formatCodexStatusText({
      bindingActive: true,
      threadState: {
        threadId: "thread-123",
        threadName: "Plan TASKS doc refresh",
        model: "gpt-5.4",
        modelProvider: "openai",
        cwd: "/repo/openclaw",
      },
      account: {
        type: "chatgpt",
        email: "user@example.com",
        planType: "pro",
      },
      projectFolder: "/repo/openclaw",
      worktreeFolder: "/repo/openclaw",
      contextUsage: {
        contextWindow: 272_000,
      },
      rateLimits: [],
    });

    expect(text).not.toContain("Context usage: ? / 272k");
    expect(text).toContain("Context usage: unavailable until Codex emits a token-usage update");
  });

  it("hides non-matching model-specific rate-limit rows", () => {
    const text = formatCodexStatusText({
      bindingActive: true,
      threadState: {
        threadId: "thread-123",
        threadName: "Plan TASKS doc refresh",
        model: "gpt-5.4",
        modelProvider: "openai",
        cwd: "/repo/openclaw",
      },
      account: {
        type: "chatgpt",
        email: "user@example.com",
        planType: "pro",
      },
      projectFolder: "/repo/openclaw",
      worktreeFolder: "/repo/openclaw",
      rateLimits: [
        { name: "5h limit", usedPercent: 4 },
        { name: "Weekly limit", usedPercent: 17 },
        { name: "GPT-5.3-Codex-Spark 5h limit", usedPercent: 0 },
        { name: "GPT-5.3-Codex-Spark Weekly limit", usedPercent: 0 },
      ],
    });

    expect(text).toContain("5h limit: 96% left");
    expect(text).toContain("Weekly limit: 83% left");
    expect(text).not.toContain("GPT-5.3-Codex-Spark 5h limit");
    expect(text).not.toContain("GPT-5.3-Codex-Spark Weekly limit");
  });

  it("groups model-specific rate-limit rows after generic rows", () => {
    const text = formatCodexStatusText({
      bindingActive: true,
      threadState: {
        threadId: "thread-123",
        threadName: "Plan TASKS doc refresh",
        model: "gpt-5.3-codex-spark",
        modelProvider: "openai",
        cwd: "/repo/openclaw",
      },
      account: {
        type: "chatgpt",
        email: "user@example.com",
        planType: "pro",
      },
      projectFolder: "/repo/openclaw",
      worktreeFolder: "/repo/openclaw",
      rateLimits: [
        { name: "GPT-5.3-Codex-Spark Weekly limit", usedPercent: 0 },
        { name: "Weekly limit", usedPercent: 17 },
        { name: "GPT-5.3-Codex-Spark 5h limit", usedPercent: 0 },
        { name: "5h limit", usedPercent: 4 },
      ],
    });

    const genericFiveHourIndex = text.indexOf("5h limit: 96% left");
    const genericWeeklyIndex = text.indexOf("Weekly limit: 83% left");
    const sparkFiveHourIndex = text.indexOf("GPT-5.3-Codex-Spark 5h limit: 100% left");
    const sparkWeeklyIndex = text.indexOf("GPT-5.3-Codex-Spark Weekly limit: 100% left");

    expect(genericFiveHourIndex).toBeGreaterThan(-1);
    expect(genericWeeklyIndex).toBeGreaterThan(genericFiveHourIndex);
    expect(sparkFiveHourIndex).toBeGreaterThan(genericWeeklyIndex);
    expect(sparkWeeklyIndex).toBeGreaterThan(sparkFiveHourIndex);
  });

  it("formats reset windows in local time and rolls stale anchors forward", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T12:00:00-05:00"));

    const text = formatCodexStatusText({
      bindingActive: true,
      threadState: {
        threadId: "thread-123",
        threadName: "Plan TASKS doc refresh",
        model: "gpt-5.4",
        modelProvider: "openai",
        cwd: "/repo/openclaw",
      },
      account: {
        type: "chatgpt",
        email: "user@example.com",
        planType: "pro",
      },
      projectFolder: "/repo/openclaw",
      worktreeFolder: "/repo/openclaw",
      rateLimits: [
        {
          name: "5h limit",
          usedPercent: 11,
          resetAt: new Date("2026-01-21T07:28:00-05:00").getTime(),
          windowSeconds: 18_000,
        },
        {
          name: "Weekly limit",
          usedPercent: 20,
          resetAt: new Date("2026-01-21T07:34:00-05:00").getTime(),
          windowSeconds: 604_800,
        },
      ],
    });

    expect(text).toContain(
      `Rate limits timezone: ${new Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    );
    expect(text).toContain("5h limit: 89% left (resets 12:28 PM)");
    expect(text).toContain("Weekly limit: 80% left (resets Mar 11)");
    expect(text).not.toContain("Jan 21");
  });
});

describe("formatThreadPickerIntro", () => {
  it("includes a legend for resume badges", () => {
    const text = formatThreadPickerIntro({
      page: 0,
      totalPages: 7,
      totalItems: 56,
      includeAll: true,
    });

    expect(text).toContain("Legend: 🌿 worktree, ✏️ uncommitted changes, U updated, C created.");
  });
});
