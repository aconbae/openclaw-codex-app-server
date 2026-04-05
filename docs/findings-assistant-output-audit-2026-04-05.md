# Findings: assistant output loss audit

Date: 2026-04-05
Repo state when written: `531eead`

## Why this document exists

The plugin repeatedly surfaced the fallback message:

> `Codex completed without a text reply.`

This happened even on turns where Codex clearly completed substantial work and, in several cases, produced a final natural-language summary.

This document records what was actually verified, what source each finding came from, and which conclusions are still only hypotheses.

---

## Executive summary

### Confirmed

1. **Codex often does produce a real final summary on failing turns.**
   This was verified from local Codex session logs in `~/.codex/logs_1.sqlite`.

2. **The app-server upstream has two distinct assistant-output item families:**
   - normalized **`ThreadItem`** notifications such as `item/completed`
   - raw **`ResponseItem`** notifications such as `rawResponseItem/completed`

3. **The plugin has repeatedly mixed those two families together under shared extraction helpers.**
   That makes one overly strict or overly loose predicate break multiple upstream surfaces at once.

4. **`rawResponseItem/completed` is an upstream-defined, first-class notification that the plugin must handle.**
   This is not speculative.

5. **`item/message/delta` is _not_ an upstream-defined notification method.**
   An earlier patch direction that targeted `item/message/delta` was not upstream-grounded.

### Still not fully proven

6. **Whether missing `role` on a raw `ResponseItem { type: "message" }` is truly valid upstream behavior.**
   Local Codex logs for at least one failing turn showed a raw response message without an obvious `role` field in the captured log body, but the upstream schema says `ResponseItem.message.role` is required. This may be:
   - log truncation,
   - incomplete log serialization,
   - or an actual runtime/protocol bug.

7. **Whether there is also a completion-order race between `turn/completed` and late final assistant-item notifications.**
   This remains a risk area, but it has not yet been proven to be the primary culprit.

---

## Evidence-backed findings

## Finding 1: failing turns can include a full final assistant summary in Codex logs

### What was observed

For multiple failing long turns, the local Codex SQLite logs contained a final raw response event:

- `response.output_item.done`
- `item.type = "message"`
- `content[].type = "output_text"`
- full final assistant summary text

Example failing turn examined during the audit:
- thread: `019d331c-d4a4-7943-b9c9-d7b75dcca0c4`
- one verified turn: `019d5b14-48ef-7922-a41d-e80eef4a14e8`
- another verified turn around 14:14 local time showed the same pattern

### Why it matters

This proves that at least some occurrences of:

> `Codex completed without a text reply.`

are **false negatives** in the plugin, not real absence of assistant output.

### Sources

- Local Codex session log database:
  - `~/.codex/logs_1.sqlite`
- Example query pattern used during audit:
  - rows matching `response.output_item.done`
  - rows matching `response.completed`
  - rows scoped to the failing time window and thread id

---

## Finding 2: upstream app-server explicitly defines `rawResponseItem/completed`

### What was observed

The generated app-server notification schema includes:

- `item/completed`
- `rawResponseItem/completed`
- `item/agentMessage/delta`
- `turn/completed`
- `thread/realtime/itemAdded`
- other event types

This was verified two ways:
1. from a locally generated schema using `codex app-server generate-ts`
2. from upstream Codex app-server schema fetched from GitHub

### Why it matters

This means `rawResponseItem/completed` is not an implementation quirk or internal-only surface. It is part of the supported protocol and should be treated as a real assistant-output source.

### Sources

- Local generated schema:
  - `/tmp/codex-app-schema/ServerNotification.ts`
- Upstream schema:
  - `https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts`
- Upstream app-server README:
  - `https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md`

---

## Finding 3: `item/completed` and `rawResponseItem/completed` carry different payload families

### What was observed

#### `item/completed`
Carries:
- `item: ThreadItem`

And upstream `ThreadItem` includes normalized assistant output as:
- `type: "agentMessage"`

#### `rawResponseItem/completed`
Carries:
- `item: ResponseItem`

And upstream `ResponseItem` includes raw model output items such as:
- `type: "message"`
- `content: Array<ContentItem>`

### Why it matters

These two notification families should not be parsed with the same simplistic assistant-item rule.

A rule that is correct for normalized thread items may be wrong for raw response items, and vice versa.

### Sources

- Local generated schema:
  - `/tmp/codex-app-schema/v2/ItemCompletedNotification.ts`
  - `/tmp/codex-app-schema/v2/ThreadItem.ts`
  - `/tmp/codex-app-schema/v2/RawResponseItemCompletedNotification.ts`
  - `/tmp/codex-app-schema/ResponseItem.ts`
- Upstream schema:
  - `https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/typescript/v2/ItemCompletedNotification.ts`
  - `https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts`
  - `https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/typescript/v2/RawResponseItemCompletedNotification.ts`
  - `https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/typescript/ResponseItem.ts`

---

## Finding 4: `item/message/delta` is not upstream-defined

### What was observed

The upstream notification schema contains:
- `item/agentMessage/delta`

But it does **not** contain:
- `item/message/delta`

### Why it matters

An earlier patch direction that tried to catch `item/message/delta` was not grounded in the actual upstream app-server protocol.

That path should not be treated as the primary fix.

### Sources

- Local generated schema:
  - `/tmp/codex-app-schema/ServerNotification.ts`
- Upstream schema:
  - `https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts`

---

## Finding 5: the plugin currently centralizes too many payload families into shared extraction helpers

### What was observed

Current plugin extraction logic is concentrated around shared helpers in:
- `src/client.ts`

Notably:
- `extractAssistantTextFromItemPayload(...)`
- `extractAssistantSnapshotFromNotificationPayload(...)`
- `extractAssistantTextFromTerminalPayload(...)`
- `extractAssistantNotificationText(...)`
- plus helper predicate logic for deciding what counts as assistant-like content

### Why it matters

This architecture makes a single predicate change affect all of these surfaces at once:
- `item/completed`
- `rawResponseItem/completed`
- `thread/read`
- `thread/realtime/itemAdded`
- nested terminal payload extraction

This is likely why the bug has resurfaced in different forms across multiple turns: several distinct protocol surfaces are being funneled through one shared notion of “assistant-like item.”

### Sources

- Plugin source:
  - `/Users/lain/workspace/plugins/openclaw-codex-app-server/src/client.ts`

---

## Finding 6: `thread/read` is useful as fallback, but is not sufficient as the primary recovery path

### What was observed

The plugin already uses `thread/read` as a fallback when completion settles without captured assistant text.

However, by design `thread/read` returns the stored thread view, which is a normalized thread representation rather than the raw response completion stream.

### Why it matters

If raw response completion arrives before the normalized thread view is fully persisted or normalized, `thread/read` can lag the live notification stream.

That means:
- `thread/read` is a good safety net,
- but not a full substitute for live handling of `rawResponseItem/completed`.

### Sources

- Plugin source:
  - `/Users/lain/workspace/plugins/openclaw-codex-app-server/src/client.ts`
- Upstream README:
  - `codex-rs/app-server/README.md`
- Upstream schema for `thread/read` response structures and `ThreadItem`

---

## Finding 7: there may still be a completion-order race risk

### What was observed

The completion logic settles after terminal notifications (`turn/completed`, `turn/failed`, `turn/cancelled`) with a short trailing settle window.

The code strongly suggests a model like:
- terminal notification received
- flush queued notifications
- settle soon
- if still empty, try `thread/read`

### Why it matters

If a late `rawResponseItem/completed` notification can arrive after `turn/completed`, then long tasks might still occasionally lose final text depending on notification ordering and timing.

### Status

This remains a **risk hypothesis**, not a proven root cause.

### Sources

- Plugin source:
  - `/Users/lain/workspace/plugins/openclaw-codex-app-server/src/client.ts`
- Upstream README discussion of streamed item notifications and turn completion ordering

---

## Finding 8: the stricter experimental assistant filter likely introduced a regression

### What was observed

A newer experimental patch broadened notification-envelope capture, but also introduced stricter logic for raw `type: "message"` items.

In one later failing turn, the captured local Codex raw response log body clearly contained:
- `type: "message"`
- `status: "completed"`
- `content[].output_text`

but the current assistant-like filter was too strict to accept that payload reliably.

### Why it matters

This likely explains at least one later resurfacing after the broader experimental patch landed.

### Status

This finding is strongly supported by code + local log evidence, but the exact role-field behavior still needs caution because upstream schema says `role` is required for `ResponseItem.message`.

### Sources

- Plugin source:
  - `/Users/lain/workspace/plugins/openclaw-codex-app-server/src/client.ts`
- Local Codex log database:
  - `~/.codex/logs_1.sqlite`
- Upstream `ResponseItem.ts`

---

## Validated conclusions

These are the conclusions that are currently well supported:

1. The plugin must treat **normalized thread items** and **raw response items** as separate parsing families.
2. The plugin must handle **`rawResponseItem/completed`** as a first-class assistant-output source.
3. `item/agentMessage/delta` is the upstream-defined streaming assistant delta method.
4. `item/message/delta` is not an upstream-defined method and should not be treated as the main fix path.
5. `thread/read` is a fallback, not a replacement for correct live capture of raw response completions.

---

## Not-yet-validated conclusions

These should remain hypotheses until directly proven:

1. That upstream intentionally emits `ResponseItem.message` without `role`.
2. That notification-order races are the primary remaining cause after correct family-specific parsing is restored.
3. That `assistantItemId` switching logic is currently dropping final summaries in multi-item long turns.

---

## Recommended next design direction

The next fix should be structured around **payload-family-specific extraction**, not broader generic heuristics.

### Recommended parsing split

#### A. `item/completed` and `thread/read` / normalized thread views
Parse as **`ThreadItem`**:
- assistant output should primarily be:
  - `type: "agentMessage"`

#### B. `rawResponseItem/completed`
Parse as **`ResponseItem`**:
- assistant output should be recognized from:
  - `type: "message"`
  - `content[].output_text`
- if role handling is uncertain, validate against actual upstream runtime payloads before hardening the predicate

#### C. `item/agentMessage/delta`
Continue to treat as streamed normalized assistant text

#### D. `turn/completed`
Use only as terminal state / backup extraction, not the primary canonical source of final assistant prose

#### E. `thread/read`
Keep only as replay fallback when live capture still ends empty

---

## Source inventory

### Local plugin source
- `/Users/lain/workspace/plugins/openclaw-codex-app-server/src/client.ts`
- `/Users/lain/workspace/plugins/openclaw-codex-app-server/src/client.test.ts`

### Local generated app-server schema
- `/tmp/codex-app-schema/ServerNotification.ts`
- `/tmp/codex-app-schema/ResponseItem.ts`
- `/tmp/codex-app-schema/v2/RawResponseItemCompletedNotification.ts`
- `/tmp/codex-app-schema/v2/ItemCompletedNotification.ts`
- `/tmp/codex-app-schema/v2/ThreadItem.ts`

Generated with:
- `codex app-server generate-ts --out /tmp/codex-app-schema`

### Local Codex session logs
- `~/.codex/logs_1.sqlite`

### Upstream references
- App-server README:
  - `https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md`
- Notification schema:
  - `https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts`
- Raw response completed payload:
  - `https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/typescript/v2/RawResponseItemCompletedNotification.ts`
- Response item union:
  - `https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/typescript/ResponseItem.ts`
- Normalized item completed payload:
  - `https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/typescript/v2/ItemCompletedNotification.ts`
- Normalized thread item union:
  - `https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts`

---

## Final note

The main lesson from this audit is not just “one more parser bug.”

It is that the plugin has been trying to interpret **distinct upstream payload families through one shared assistant-item heuristic**, and that design makes regressions likely whenever a new notification surface is added or tightened.
