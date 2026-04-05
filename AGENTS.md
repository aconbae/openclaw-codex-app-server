# Repository Guidelines

## Project Structure & Module Organization
`index.ts` is the plugin entrypoint and registers commands, services, and interactive handlers. Core implementation lives in [`src/`](./src): controller flow in `controller.ts`, API/client integration in `client.ts`, configuration in `config.ts`, state and thread helpers in `state.ts`, `thread-picker.ts`, and `thread-selection.ts`, and user-facing text formatting in `format.ts`. Tests are colocated with source files as `src/*.test.ts`. Plugin metadata lives in `openclaw.plugin.json`; package and TypeScript settings are in `package.json` and `tsconfig.json`.

Design notes and upstream behavior captures live under [`docs/specs/`](./docs/specs). Before changing approval, trust, sandbox, file-edit, or media-handling behavior, review [`docs/specs/PERMISSIONS.md`](./docs/specs/PERMISSIONS.md) and [`docs/specs/MEDIA.md`](./docs/specs/MEDIA.md).

## Assistant Output Architecture
Default chat turns now behave like a stateful event consumer instead of a one-shot final-text extractor.

- `src/client.ts` remains the upstream-facing notification processor. It consumes App Server notifications serially, keeps assistant state from canonical assistant surfaces, and emits batched live assistant text snapshots through `startTurn(... onAssistantMessage)`.
- `src/controller.ts` owns provider UX. For successful default turns, it renders assistant text into provider-native progressive replies and treats what the user already saw in chat as the canonical reply.
- The empty successful-turn fallback string, `Codex completed without a text reply.`, is now only for cases where no assistant text was ever rendered. Do not reintroduce logic that sends that fallback after live assistant text has already been delivered.
- The plugin still has a local post-terminal settle boundary in the client for turn completion and replay recovery, but successful chat delivery should not depend on that boundary once live assistant text is visible.
- Plan mode and review mode keep their own delivery paths. The live assistant transcript architecture here applies to the default turn flow.

Provider rendering is intentionally not identical across channels:

- Telegram now keeps append-only chat history for live assistant output. As assistant text expands, the controller sends only the newly observed suffix as fresh Telegram messages instead of editing earlier progress updates in place.
- Discord follows OpenClaw's host-side preview model more closely. The controller keeps a single throttled preview message during streaming, then reuses that message as the first final chunk and only sends spillover chunks after completion.
- Do not collapse both providers back to one generic renderer unless the OpenClaw plugin SDK grows a first-class provider-neutral draft-stream lifecycle. Today the SDK exposes chunking helpers, outbound sends, typing leases, and Discord component-message edits, but not the host's internal reply pipeline or draft lifecycle helpers.

When changing assistant-output behavior:

- Keep protocol parsing upstream-grounded. `item/completed` and `thread/read` are normalized `ThreadItem` surfaces; `rawResponseItem/completed` is a raw `ResponseItem` surface.
- Preserve the split of responsibilities: client gathers and normalizes assistant state, controller decides how to render it in Telegram and Discord.
- Keep Discord preview behavior host-aligned: one editable preview message, throttled updates, then finalize in place plus spillover chunks instead of building a multi-message live transcript up front.
- Update both `src/client.test.ts` and `src/controller.test.ts` for any regression involving live assistant streaming, completion fallback behavior, or provider message editing.

## Project Management
Use the repo-local [`project-manager`](./.agents/skills/project-manager/SKILL.md) skill for GitHub issue and project-board work in this repository.

- Repo/project config: `.agents/project-manager.config.json`
- Project board: <https://github.com/orgs/pwrdrvr/projects/7>
- Canonical local tracker: `.local/work-items.yaml` (derived; refresh with `pnpm project:sync`)
- Canonical local issue drafts: `.local/issue-drafts/`
- Do not create parallel scratch trackers or alternate temp directories for issue workups.

## Build, Test, and Development Commands
Use `pnpm` for local work.

- After committed `package.json` changes, run `pnpm install` so `pnpm-lock.yaml` stays in sync. If a peer range points past the newest npm release, do not commit that unresolved peer bump yet; keep registry-facing compatibility in `openclaw.compat` / `openclaw.build` until the matching package version exists.
- `pnpm test`: run the Vitest suite once.
- `pnpm typecheck`: run strict TypeScript checking with `tsc --noEmit`.
- `pnpm openclaw plugins install --link /path/to/openclaw-codex-app-server`: link this package into a local OpenClaw checkout for manual integration testing.

There is no separate build step in this repository; correctness is gated by tests and typechecking.

## Coding Style & Naming Conventions
Write TypeScript targeting Node ESM (`"module": "NodeNext"`). Match the existing style: 2-space indentation, double quotes, semicolons, and small focused helpers. Use `PascalCase` for classes and types, `camelCase` for functions and variables, and `SCREAMING_SNAKE_CASE` for shared constants such as command lists or namespace identifiers. Keep command and plugin-facing strings explicit and near the registration code when possible.

## Testing Guidelines
Tests use Vitest and should stay next to the code they cover, named `*.test.ts`. Prefer narrow unit tests over broad fixtures; most existing tests assert exact payloads and formatting behavior. Run `pnpm test` and `pnpm typecheck` before opening a PR. Add or update tests for any command handling, thread-selection logic, formatting branch, or protocol-shape change.

## Commit & Pull Request Guidelines
Follow the repository’s existing commit style: short imperative subjects, often with a `Plugin:` prefix, for example `Plugin: restore Codex interactive workflows`. Keep commits scoped to one behavior change. PRs should include a concise summary, linked issue or context, and the exact validation performed (`pnpm test`, `pnpm typecheck`, manual OpenClaw plugin exercise). Include screenshots or message transcripts when changing interactive Telegram or Discord flows.

## Command Help Text
Every `/cas_*` command has structured help metadata in `src/help.ts`.
When adding, removing, or changing a command's flags, arguments, or behavior,
update the corresponding entry in `COMMAND_HELP` and the README command
reference table to keep them in sync.
