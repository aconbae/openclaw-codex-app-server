import { describe, expect, it } from "vitest";
import {
  buildPendingQuestionnaireResponse,
  buildPendingPromptText,
  buildPendingUserInputActions,
  createPendingInputState,
  formatPendingQuestionnairePrompt,
  parseCodexUserInput,
  parsePendingQuestionnaire,
  questionnaireCurrentQuestionHasAnswer,
  questionnaireIsComplete,
  requestToken,
} from "./pending-input.js";

describe("pending-input helpers", () => {
  it("parses numeric option replies", () => {
    expect(parseCodexUserInput("2", 3)).toEqual({ kind: "option", index: 1 });
    expect(parseCodexUserInput("option 1", 3)).toEqual({ kind: "option", index: 0 });
    expect(parseCodexUserInput("hello", 3)).toEqual({ kind: "text", text: "hello" });
  });

  it("builds approval actions from request decisions", () => {
    const actions = buildPendingUserInputActions({
      method: "turn/requestApproval",
      requestParams: {
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
    });
    expect(actions.map((action) => action.label)).toEqual([
      "Approve Once",
      "Approve for Session",
      "Decline",
      "Cancel",
      "Tell Codex What To Do",
    ]);
  });

  it("creates a stable request token", () => {
    expect(requestToken("abc")).toBe(requestToken("abc"));
    expect(requestToken("abc")).not.toBe(requestToken("def"));
  });

  it("creates a prompt text for pending input", () => {
    const state = createPendingInputState({
      method: "item/tool/requestUserInput",
      requestId: "req-1",
      requestParams: {
        question: "Pick one",
      },
      options: ["A", "B"],
      expiresAt: Date.now() + 60_000,
    });
    expect(state.promptText).toContain("Codex input requested");
    expect(state.promptText).toContain("Choices:");
  });

  it("truncates oversized pending request prompts for chat delivery", () => {
    const text = buildPendingPromptText({
      method: "item/tool/requestUserInput",
      requestId: "req-2",
      requestParams: {
        details: "A".repeat(5000),
      },
      options: ["A", "B"],
      actions: [],
      expiresAt: Date.now() + 60_000,
    });
    expect(text.length).toBeLessThan(2400);
    expect(text).toContain("[Prompt truncated for chat delivery.");
  });

  it("parses multi-question plan prompts into a questionnaire state", () => {
    const questionnaire = parsePendingQuestionnaire(`
1. What do you want the final artifact to be?

• A Single static binary
• B Normal runtime-managed CLI

Guidance:
• A points toward Go or Rust.

2. What do you care about more: delivery speed or long-term rigor?

• A Fastest rewrite
• B Balanced
    `);

    expect(questionnaire?.questions).toHaveLength(2);
    expect(questionnaire?.questions[0]).toMatchObject({
      id: "q1",
      prompt: "What do you want the final artifact to be?",
      options: [
        { key: "A", label: "Single static binary" },
        { key: "B", label: "Normal runtime-managed CLI" },
      ],
    });
    expect(formatPendingQuestionnairePrompt(questionnaire!)).toContain("Codex plan question 1 of 2");
  });

  it("renders a compact questionnaire reply once all answers are filled in", () => {
    const questionnaire = parsePendingQuestionnaire(`
1. What do you want the final artifact to be?
• A Single static binary
• B Normal runtime-managed CLI

2. What do you care about more?
• A Fastest rewrite
• B Balanced
    `)!;
    questionnaire.answers[0] = {
      kind: "option",
      optionKey: "A",
      optionLabel: "Single static binary",
    };
    questionnaire.answers[1] = {
      kind: "text",
      text: "Balanced, but only if we keep the migration simple.",
    };
    expect(questionnaireIsComplete(questionnaire)).toBe(true);
    expect(buildPendingQuestionnaireResponse(questionnaire)).toBe(
      "1A 2: Balanced, but only if we keep the migration simple.",
    );
  });

  it("requires an answer before advancing to the next questionnaire question", () => {
    const questionnaire = parsePendingQuestionnaire(`
1. What do you want the final artifact to be?
• A Single static binary
• B Normal runtime-managed CLI

2. What do you care about more?
• A Fastest rewrite
• B Balanced
    `)!;

    expect(questionnaireCurrentQuestionHasAnswer(questionnaire)).toBe(false);

    questionnaire.answers[0] = {
      kind: "option",
      optionKey: "A",
      optionLabel: "Single static binary",
    };

    expect(questionnaireCurrentQuestionHasAnswer(questionnaire)).toBe(true);
  });

  it("parses structured request_user_input questions into questionnaire state", () => {
    const state = createPendingInputState({
      method: "item/tool/requestUserInput",
      requestId: "req-3",
      requestParams: {
        questions: [
          {
            id: "runtime",
            header: "Runtime",
            question: "Which runtime shape should we optimize for?",
            isOther: true,
            options: [
              {
                label: "Long-lived service (Recommended)",
                description: "Best fit for stateful flows.",
              },
              {
                label: "Mostly serverless",
                description: "Best fit for stateless handlers.",
              },
            ],
          },
          {
            id: "db",
            header: "DB",
            question: "What kind of database migration do you want from SQLite?",
            options: [{ label: "Postgres (Recommended)" }, { label: "Firestore" }],
          },
        ],
      },
      options: [],
      expiresAt: Date.now() + 60_000,
    });

    expect(state.questionnaire?.questions).toHaveLength(2);
    expect(state.questionnaire?.questions[0]).toMatchObject({
      id: "runtime",
      header: "Runtime",
      prompt: "Which runtime shape should we optimize for?",
      allowFreeform: true,
      options: [
        {
          key: "A",
          label: "Long-lived service (Recommended)",
          description: "Best fit for stateful flows.",
          recommended: true,
        },
        {
          key: "B",
          label: "Mostly serverless",
          description: "Best fit for stateless handlers.",
          recommended: false,
        },
      ],
    });
    expect(formatPendingQuestionnairePrompt(state.questionnaire!)).toContain(
      "Runtime: Which runtime shape should we optimize for?",
    );
    expect(formatPendingQuestionnairePrompt(state.questionnaire!)).toContain(
      "Other: You can reply with free text.",
    );
    state.questionnaire!.answers[0] = {
      kind: "option",
      optionKey: "A",
      optionLabel: "Long-lived service (Recommended)",
    };
    state.questionnaire!.answers[1] = {
      kind: "option",
      optionKey: "A",
      optionLabel: "Postgres (Recommended)",
    };
    expect(buildPendingQuestionnaireResponse(state.questionnaire!)).toEqual({
      answers: {
        runtime: { answers: ["Long-lived service (Recommended)"] },
        db: { answers: ["Postgres (Recommended)"] },
      },
    });
  });
});
