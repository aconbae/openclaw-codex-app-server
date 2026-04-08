import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { CALLBACK_TTL_MS, CALLBACK_TOKEN_BYTES, PLUGIN_ID, STORE_VERSION } from "./types.js";
import type {
  CallbackAction,
  CollaborationMode,
  ConversationTarget,
  ConversationPreferences,
  PermissionsMode,
  StoreSnapshot,
  StoredBinding,
  StoredPendingBind,
  StoredPendingRequest,
} from "./types.js";

type PutCallbackInput =
  | {
      kind: "start-new-thread";
      conversation: ConversationTarget;
      workspaceDir: string;
      syncTopic?: boolean;
      requestedModel?: string;
      requestedFast?: boolean;
      requestedYolo?: boolean;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "resume-thread";
      conversation: ConversationTarget;
      threadId: string;
      threadTitle?: string;
      workspaceDir: string;
      syncTopic?: boolean;
      requestedModel?: string;
      requestedFast?: boolean;
      requestedYolo?: boolean;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "pending-input";
      conversation: ConversationTarget;
      requestId: string;
      actionIndex: number;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "pending-questionnaire";
      conversation: ConversationTarget;
      requestId: string;
      questionIndex: number;
      action: "select" | "prev" | "next" | "freeform";
      optionIndex?: number;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "picker-view";
      conversation: ConversationTarget;
      view: Extract<CallbackAction, { kind: "picker-view" }>["view"];
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "run-prompt";
      conversation: ConversationTarget;
      prompt: string;
      workspaceDir?: string;
      collaborationMode?: CollaborationMode;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "rename-thread";
      conversation: ConversationTarget;
      style: "thread-project" | "thread";
      syncTopic: boolean;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "toggle-fast";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "show-reasoning-picker";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "set-reasoning";
      conversation: ConversationTarget;
      reasoningEffort: string;
      returnToStatus?: boolean;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "toggle-permissions";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "compact-thread";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "stop-run";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "refresh-status";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "detach-thread";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "show-skills";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "show-mcp";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "run-skill";
      conversation: ConversationTarget;
      skillName: string;
      workspaceDir?: string;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "show-skill-help";
      conversation: ConversationTarget;
      skillName: string;
      description?: string;
      cwd?: string;
      enabled?: boolean;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "show-model-picker";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "set-model";
      conversation: ConversationTarget;
      model: string;
      returnToStatus?: boolean;
      statusMessage?: Extract<CallbackAction, { kind: "set-model" }>["statusMessage"];
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "reply-text";
      conversation: ConversationTarget;
      text: string;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "cancel-picker";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    };

function toConversationKey(target: ConversationTarget): string {
  const normalized = normalizeConversationTarget(target);
  const channel = normalized.channel.trim().toLowerCase();
  return [
    channel,
    normalized.accountId.trim(),
    normalized.conversationId.trim(),
    channel === "telegram" ? "" : normalized.parentConversationId?.trim() ?? "",
  ].join("::");
}

function normalizeConversationTarget<T extends ConversationTarget>(target: T): T {
  const channel = target.channel.trim().toLowerCase();
  if (channel !== "telegram") {
    return {
      ...target,
      channel,
      accountId: target.accountId.trim(),
      conversationId: target.conversationId.trim(),
      parentConversationId: target.parentConversationId?.trim() || undefined,
    };
  }
  const conversationId = target.conversationId.trim();
  const topicMarker = ":topic:";
  const topicIndex = conversationId.indexOf(topicMarker);
  if (topicIndex === -1) {
    return {
      ...target,
      channel: "telegram",
      accountId: target.accountId.trim(),
      conversationId,
      parentConversationId: undefined,
    };
  }
  const baseConversationId = conversationId.slice(0, topicIndex);
  return {
    ...target,
    channel: "telegram",
    accountId: target.accountId.trim(),
    conversationId,
    parentConversationId: target.parentConversationId?.trim() || baseConversationId,
  };
}

function pickLatestByUpdatedAt<T extends { updatedAt?: number }>(left: T, right: T): T {
  return (right.updatedAt ?? 0) >= (left.updatedAt ?? 0) ? right : left;
}

function normalizeBinding(binding: StoredBinding): StoredBinding {
  return {
    ...binding,
    conversation: normalizeConversationTarget(binding.conversation),
  };
}

function normalizePendingBind(entry: StoredPendingBind): StoredPendingBind {
  return {
    ...entry,
    conversation: normalizeConversationTarget(entry.conversation),
  };
}

function normalizePendingRequest(entry: StoredPendingRequest): StoredPendingRequest {
  return {
    ...entry,
    conversation: normalizeConversationTarget(entry.conversation),
  };
}

function normalizeCallbackAction(entry: CallbackAction): CallbackAction {
  return {
    ...entry,
    conversation: normalizeConversationTarget(entry.conversation),
  };
}

function cloneSnapshot(value?: Partial<StoreSnapshot>): StoreSnapshot {
  return {
    version: STORE_VERSION,
    bindings: value?.bindings ?? [],
    pendingBinds: value?.pendingBinds ?? [],
    pendingRequests: value?.pendingRequests ?? [],
    callbacks: value?.callbacks ?? [],
  };
}

function normalizePermissionsMode(value?: string | null): PermissionsMode | undefined {
  return value === "full-access" ? "full-access" : value === "default" ? "default" : undefined;
}

function inferPermissionsModeFromLegacyFields(params: {
  permissionsMode?: string | null;
  appServerProfile?: string | null;
  preferredApprovalPolicy?: string | null;
  preferredSandbox?: string | null;
}): PermissionsMode {
  const explicit =
    normalizePermissionsMode(params.permissionsMode) ??
    normalizePermissionsMode(params.appServerProfile);
  if (explicit) {
    return explicit;
  }
  const approval = params.preferredApprovalPolicy?.trim();
  const sandbox = params.preferredSandbox?.trim();
  if (approval === "never" && sandbox === "danger-full-access") {
    return "full-access";
  }
  return "full-access";
}

function normalizeConversationPreferences(
  value: (ConversationPreferences & {
    preferredApprovalPolicy?: string;
    preferredSandbox?: string;
  }) | undefined,
): ConversationPreferences | undefined {
  if (!value) {
    return undefined;
  }
  return {
    preferredModel: value.preferredModel,
    preferredReasoningEffort: value.preferredReasoningEffort,
    preferredServiceTier: value.preferredServiceTier,
    updatedAt: value.updatedAt,
  };
}

function normalizeSnapshot(value?: Partial<StoreSnapshot>): StoreSnapshot {
  const snapshot = cloneSnapshot(value);
  snapshot.version = STORE_VERSION;
  const bindingByKey = new Map<string, StoredBinding>();
  snapshot.bindings = snapshot.bindings
    .map((binding) => {
    const legacyPreferences = binding.preferences as
      | (ConversationPreferences & {
          preferredApprovalPolicy?: string;
          preferredSandbox?: string;
        })
      | undefined;
      return normalizeBinding({
        ...binding,
        permissionsMode: inferPermissionsModeFromLegacyFields({
          permissionsMode: (binding as StoredBinding & { permissionsMode?: string }).permissionsMode,
        appServerProfile: (binding as StoredBinding & { appServerProfile?: string }).appServerProfile,
        preferredApprovalPolicy: legacyPreferences?.preferredApprovalPolicy,
        preferredSandbox: legacyPreferences?.preferredSandbox,
      }),
      pendingPermissionsMode:
        normalizePermissionsMode(
          (binding as StoredBinding & { pendingPermissionsMode?: string }).pendingPermissionsMode,
        ) ??
        normalizePermissionsMode(
          (binding as StoredBinding & { pendingAppServerProfile?: string }).pendingAppServerProfile,
        ),
        preferences: normalizeConversationPreferences(legacyPreferences),
      });
    })
    .filter((binding) => {
      const key = toConversationKey(binding.conversation);
      const current = bindingByKey.get(key);
      bindingByKey.set(
        key,
        current && current.threadId === binding.threadId && current.sessionKey === binding.sessionKey
          ? {
              ...pickLatestByUpdatedAt(current, binding),
              contextUsage: binding.contextUsage ?? current.contextUsage,
              pinnedBindingMessage: binding.pinnedBindingMessage ?? current.pinnedBindingMessage,
              preferences: binding.preferences ?? current.preferences,
              threadTitle: binding.threadTitle ?? current.threadTitle,
              permissionsMode: binding.permissionsMode ?? current.permissionsMode,
              pendingPermissionsMode:
                binding.pendingPermissionsMode ?? current.pendingPermissionsMode,
            }
          : current
            ? pickLatestByUpdatedAt(current, binding)
            : binding,
      );
      return false;
    });
  snapshot.bindings = [...bindingByKey.values()];
  const pendingBindByKey = new Map<string, StoredPendingBind>();
  snapshot.pendingBinds = snapshot.pendingBinds
    .map((entry) => {
    const legacyPreferences = entry.preferences as
      | (ConversationPreferences & {
          preferredApprovalPolicy?: string;
          preferredSandbox?: string;
        })
      | undefined;
      return normalizePendingBind({
        ...entry,
        permissionsMode: inferPermissionsModeFromLegacyFields({
          permissionsMode: (entry as StoredPendingBind & { permissionsMode?: string }).permissionsMode,
        appServerProfile: (entry as StoredPendingBind & { appServerProfile?: string }).appServerProfile,
        preferredApprovalPolicy: legacyPreferences?.preferredApprovalPolicy,
          preferredSandbox: legacyPreferences?.preferredSandbox,
      }),
      preferences: normalizeConversationPreferences(legacyPreferences),
      });
    })
    .filter((entry) => {
      const key = toConversationKey(entry.conversation);
      const current = pendingBindByKey.get(key);
      pendingBindByKey.set(key, current ? pickLatestByUpdatedAt(current, entry) : entry);
      return false;
    });
  snapshot.pendingBinds = [...pendingBindByKey.values()];
  snapshot.pendingRequests = snapshot.pendingRequests.map(normalizePendingRequest);
  snapshot.callbacks = snapshot.callbacks.map(normalizeCallbackAction);
  return snapshot;
}

export class PluginStateStore {
  private snapshot = cloneSnapshot();

  constructor(private readonly rootDir: string) {}

  get dir(): string {
    return path.join(this.rootDir, PLUGIN_ID);
  }

  get filePath(): string {
    return path.join(this.dir, "state.json");
  }

  async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreSnapshot>;
      this.snapshot = normalizeSnapshot(parsed);
      this.pruneExpired();
      await this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.snapshot = cloneSnapshot();
      await this.save();
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(this.snapshot, null, 2)}\n`, "utf8");
  }

  pruneExpired(now = Date.now()): void {
    this.snapshot.pendingBinds = this.snapshot.pendingBinds.filter(
      (entry) => now - entry.updatedAt < CALLBACK_TTL_MS,
    );
    this.snapshot.pendingRequests = this.snapshot.pendingRequests.filter(
      (entry) => entry.state.expiresAt > now,
    );
    this.snapshot.callbacks = this.snapshot.callbacks.filter((entry) => entry.expiresAt > now);
  }

  listBindings(): StoredBinding[] {
    return [...this.snapshot.bindings];
  }

  getBinding(target: ConversationTarget): StoredBinding | null {
    const key = toConversationKey(target);
    return this.snapshot.bindings.find((entry) => toConversationKey(entry.conversation) === key) ?? null;
  }

  async upsertBinding(binding: StoredBinding): Promise<void> {
    const normalizedBinding = normalizeBinding(binding);
    const key = toConversationKey(normalizedBinding.conversation);
    this.snapshot.bindings = this.snapshot.bindings.filter(
      (entry) => toConversationKey(entry.conversation) !== key,
    );
    this.snapshot.pendingBinds = this.snapshot.pendingBinds.filter(
      (entry) => toConversationKey(entry.conversation) !== key,
    );
    this.snapshot.bindings.push(normalizedBinding);
    await this.save();
  }

  async removeBinding(target: ConversationTarget): Promise<void> {
    const key = toConversationKey(target);
    this.snapshot.bindings = this.snapshot.bindings.filter(
      (entry) => toConversationKey(entry.conversation) !== key,
    );
    this.snapshot.pendingBinds = this.snapshot.pendingBinds.filter(
      (entry) => toConversationKey(entry.conversation) !== key,
    );
    this.snapshot.pendingRequests = this.snapshot.pendingRequests.filter(
      (entry) => toConversationKey(entry.conversation) !== key,
    );
    this.snapshot.callbacks = this.snapshot.callbacks.filter(
      (entry) => toConversationKey(entry.conversation) !== key,
    );
    await this.save();
  }

  getPendingRequestByConversation(target: ConversationTarget): StoredPendingRequest | null {
    const key = toConversationKey(target);
    return (
      this.snapshot.pendingRequests.find((entry) => toConversationKey(entry.conversation) === key) ??
      null
    );
  }

  getPendingBind(target: ConversationTarget): StoredPendingBind | null {
    const key = toConversationKey(target);
    return (
      this.snapshot.pendingBinds.find((entry) => toConversationKey(entry.conversation) === key) ??
      null
    );
  }

  async upsertPendingBind(entry: StoredPendingBind): Promise<void> {
    const normalizedEntry = normalizePendingBind(entry);
    const key = toConversationKey(normalizedEntry.conversation);
    this.snapshot.pendingBinds = this.snapshot.pendingBinds.filter(
      (current) => toConversationKey(current.conversation) !== key,
    );
    this.snapshot.pendingBinds.push(normalizedEntry);
    await this.save();
  }

  async removePendingBind(target: ConversationTarget): Promise<void> {
    const key = toConversationKey(target);
    this.snapshot.pendingBinds = this.snapshot.pendingBinds.filter(
      (entry) => toConversationKey(entry.conversation) !== key,
    );
    await this.save();
  }

  getPendingRequestById(requestId: string): StoredPendingRequest | null {
    return this.snapshot.pendingRequests.find((entry) => entry.requestId === requestId) ?? null;
  }

  async upsertPendingRequest(entry: StoredPendingRequest): Promise<void> {
    const normalizedEntry = normalizePendingRequest(entry);
    this.snapshot.pendingRequests = this.snapshot.pendingRequests.filter(
      (current) => current.requestId !== normalizedEntry.requestId,
    );
    this.snapshot.pendingRequests.push(normalizedEntry);
    await this.save();
  }

  async removePendingRequest(requestId: string): Promise<void> {
    this.snapshot.pendingRequests = this.snapshot.pendingRequests.filter(
      (entry) => entry.requestId !== requestId,
    );
    this.snapshot.callbacks = this.snapshot.callbacks.filter((entry) => {
      if (entry.kind !== "pending-input" && entry.kind !== "pending-questionnaire") {
        return true;
      }
      return entry.requestId !== requestId;
    });
    await this.save();
  }

  createCallbackToken(): string {
    return crypto.randomBytes(CALLBACK_TOKEN_BYTES).toString("base64url");
  }

  async putCallback(callback: PutCallbackInput): Promise<CallbackAction> {
    const now = Date.now();
    const normalizedConversation = normalizeConversationTarget(callback.conversation);
    const entry: CallbackAction =
      callback.kind === "start-new-thread"
        ? {
            kind: "start-new-thread",
            conversation: normalizedConversation,
            workspaceDir: callback.workspaceDir,
            syncTopic: callback.syncTopic,
            requestedModel: callback.requestedModel,
            requestedFast: callback.requestedFast,
            requestedYolo: callback.requestedYolo,
            token: callback.token ?? this.createCallbackToken(),
            createdAt: now,
            expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
          }
      : callback.kind === "resume-thread"
        ? {
            kind: "resume-thread",
            conversation: normalizedConversation,
            threadId: callback.threadId,
            threadTitle: callback.threadTitle,
            workspaceDir: callback.workspaceDir,
            syncTopic: callback.syncTopic,
            requestedModel: callback.requestedModel,
            requestedFast: callback.requestedFast,
            requestedYolo: callback.requestedYolo,
            token: callback.token ?? this.createCallbackToken(),
            createdAt: now,
            expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
          }
        : callback.kind === "pending-input"
          ? {
              kind: "pending-input",
              conversation: normalizedConversation,
              requestId: callback.requestId,
              actionIndex: callback.actionIndex,
              token: callback.token ?? this.createCallbackToken(),
              createdAt: now,
              expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
            }
          : callback.kind === "pending-questionnaire"
            ? {
                kind: "pending-questionnaire",
                conversation: normalizedConversation,
                requestId: callback.requestId,
                questionIndex: callback.questionIndex,
                action: callback.action,
                optionIndex: callback.optionIndex,
                token: callback.token ?? this.createCallbackToken(),
                createdAt: now,
                expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
              }
          : callback.kind === "picker-view"
            ? {
              kind: "picker-view",
              conversation: normalizedConversation,
              view: callback.view,
              token: callback.token ?? this.createCallbackToken(),
              createdAt: now,
              expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
              }
              : callback.kind === "run-prompt"
                ? {
                    kind: "run-prompt",
                    conversation: normalizedConversation,
                    prompt: callback.prompt,
                  workspaceDir: callback.workspaceDir,
                  collaborationMode: callback.collaborationMode,
                  token: callback.token ?? this.createCallbackToken(),
                  createdAt: now,
                  expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                }
              : callback.kind === "rename-thread"
                ? {
                    kind: "rename-thread",
                    conversation: normalizedConversation,
                    style: callback.style,
                    syncTopic: callback.syncTopic,
                    token: callback.token ?? this.createCallbackToken(),
                    createdAt: now,
                    expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                  }
              : callback.kind === "set-model"
                ? {
                    kind: "set-model",
                    conversation: normalizedConversation,
                    model: callback.model,
                    returnToStatus: callback.returnToStatus,
                    statusMessage: callback.statusMessage,
                  token: callback.token ?? this.createCallbackToken(),
                  createdAt: now,
                  expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                  }
                : callback.kind === "toggle-fast"
                  ? {
                      kind: "toggle-fast",
                      conversation: normalizedConversation,
                      token: callback.token ?? this.createCallbackToken(),
                      createdAt: now,
                      expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                    }
                : callback.kind === "show-reasoning-picker"
                  ? {
                      kind: "show-reasoning-picker",
                      conversation: normalizedConversation,
                      token: callback.token ?? this.createCallbackToken(),
                      createdAt: now,
                      expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                    }
              : callback.kind === "set-reasoning"
                ? {
                    kind: "set-reasoning",
                    conversation: normalizedConversation,
                    reasoningEffort: callback.reasoningEffort,
                    returnToStatus: callback.returnToStatus,
                    token: callback.token ?? this.createCallbackToken(),
                    createdAt: now,
                    expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                  }
                  : callback.kind === "toggle-permissions"
                    ? {
                        kind: "toggle-permissions",
                        conversation: normalizedConversation,
                        token: callback.token ?? this.createCallbackToken(),
                        createdAt: now,
                        expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                      }
                    : callback.kind === "compact-thread"
                      ? {
                          kind: "compact-thread",
                          conversation: normalizedConversation,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                    : callback.kind === "stop-run"
                      ? {
                          kind: "stop-run",
                          conversation: normalizedConversation,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                    : callback.kind === "refresh-status"
                      ? {
                          kind: "refresh-status",
                          conversation: normalizedConversation,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                    : callback.kind === "detach-thread"
                      ? {
                          kind: "detach-thread",
                          conversation: normalizedConversation,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                    : callback.kind === "show-skills"
                      ? {
                          kind: "show-skills",
                          conversation: normalizedConversation,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                    : callback.kind === "show-mcp"
                      ? {
                          kind: "show-mcp",
                          conversation: normalizedConversation,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                    : callback.kind === "run-skill"
                      ? {
                          kind: "run-skill",
                          conversation: normalizedConversation,
                          skillName: callback.skillName,
                          workspaceDir: callback.workspaceDir,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                    : callback.kind === "show-skill-help"
                      ? {
                          kind: "show-skill-help",
                          conversation: normalizedConversation,
                          skillName: callback.skillName,
                          description: callback.description,
                          cwd: callback.cwd,
                          enabled: callback.enabled,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                    : callback.kind === "show-model-picker"
                      ? {
                          kind: "show-model-picker",
                          conversation: normalizedConversation,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                : callback.kind === "reply-text"
                  ? {
                      kind: "reply-text",
                      conversation: normalizedConversation,
                      text: callback.text,
                      token: callback.token ?? this.createCallbackToken(),
                      createdAt: now,
                      expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                    }
                  : {
                      kind: "cancel-picker",
                      conversation: normalizedConversation,
                      token: callback.token ?? this.createCallbackToken(),
                      createdAt: now,
                      expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                    };
    this.snapshot.callbacks = this.snapshot.callbacks.filter(
      (current) => current.token !== entry.token,
    );
    this.snapshot.callbacks.push(entry);
    await this.save();
    return entry;
  }

  getCallback(token: string): CallbackAction | null {
    return this.snapshot.callbacks.find((entry) => entry.token === token) ?? null;
  }

  async removeCallback(token: string): Promise<void> {
    this.snapshot.callbacks = this.snapshot.callbacks.filter((entry) => entry.token !== token);
    await this.save();
  }
}

export function buildPluginSessionKey(threadId: string): string {
  return `${PLUGIN_ID}:thread:${threadId.trim()}`;
}

export function buildConversationKey(target: ConversationTarget): string {
  return toConversationKey(target);
}
