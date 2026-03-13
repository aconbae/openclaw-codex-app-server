import { describe, expect, it } from "vitest";
import { __testing } from "./client.js";

describe("extractThreadTokenUsageSnapshot", () => {
  it("prefers current-context usage over cumulative totals when both are present", () => {
    expect(
      __testing.extractThreadTokenUsageSnapshot({
        threadId: "thread-123",
        tokenUsage: {
          last: {
            totalTokens: 139_000,
            inputTokens: 120_000,
            cachedInputTokens: 9_000,
            outputTokens: 10_000,
          },
          total: {
            totalTokens: 56_100_000,
            inputTokens: 55_000_000,
            cachedInputTokens: 300_000,
            outputTokens: 1_100_000,
          },
          modelContextWindow: 258_000,
        },
      }),
    ).toEqual({
      totalTokens: 139_000,
      inputTokens: 120_000,
      cachedInputTokens: 9_000,
      outputTokens: 10_000,
      reasoningOutputTokens: undefined,
      contextWindow: 258_000,
      remainingTokens: 119_000,
      remainingPercent: 46,
    });
  });

  it("normalizes thread/tokenUsage/updated notifications into a context snapshot", () => {
    expect(
      __testing.extractThreadTokenUsageSnapshot({
        threadId: "thread-123",
        turnId: "turn-123",
        tokenUsage: {
          total: {
            totalTokens: 54_000,
            inputTokens: 49_000,
            cachedInputTokens: 3_000,
            outputTokens: 5_000,
            reasoningOutputTokens: 1_000,
          },
          modelContextWindow: 272_000,
        },
      }),
    ).toEqual({
      totalTokens: 54_000,
      inputTokens: 49_000,
      cachedInputTokens: 3_000,
      outputTokens: 5_000,
      reasoningOutputTokens: 1_000,
      contextWindow: 272_000,
      remainingTokens: 218_000,
      remainingPercent: 80,
    });
  });
});
