# AGENTS.md

Guidance for AI coding agents working in this repository. Human contributors should read `README.md` first.

## Project overview

Agent Maestro is a VS Code extension that:

- Orchestrates third-party AI coding extensions (Cline, Roo Code, Kilo Code, etc.) via internal adapters.
- Exposes a local proxy server (default port `23333`) presenting OpenAI-, Anthropic-, and Gemini-compatible APIs backed by the VS Code Language Model API (GitHub Copilot models), used by clients such as Claude Code, Codex, and Gemini.
- Runs an MCP server (default port `23334`) for Model Context Protocol clients.

Primary language: **TypeScript** (ESM, Node ≥ 22, VS Code ≥ 1.100). Package manager: **pnpm 10**.

## Repository layout

- `src/extension.ts` — extension entry point.
- `src/commands/` — VS Code command handlers registered in `package.json`.
- `src/core/` — adapters for third-party extensions (`ClineAdapter`, `RooCodeAdapter`, etc.) and the central `controller`.
- `src/server/` — proxy + MCP servers.
  - `routes/anthropicRoutes.ts`, `routes/openai/` — API-compatible endpoints.
  - `schemas/` — Zod request/response schemas (also drive OpenAPI).
  - `utils/` — request conversion helpers between Anthropic/OpenAI and the VS Code LM API.
- `src/utils/` — shared utilities (logger, config, chat-model resolution, Claude Code helpers).
- `src/test/` — Mocha tests run via `@vscode/test-electron`.
- `docs/`, `website/` — user-facing documentation.
- `.changeset/` — pending release notes (Changesets).

## Commands

Run via pnpm. Do not use npm or yarn.

| Task                | Command            |
| ------------------- | ------------------ |
| Install deps        | `pnpm install`     |
| Type-check          | `pnpm check-types` |
| Lint                | `pnpm lint`        |
| Build (dev)         | `pnpm build`       |
| Build (prod)        | `pnpm build:prod`  |
| Run tests           | `pnpm test`        |
| Watch (build + tsc) | `pnpm watch`       |
| Add a changeset     | `pnpm changeset`   |

`pnpm test` boots a VS Code test host and is slow; prefer `pnpm check-types` + `pnpm lint` for fast feedback during edits, and only run the full test suite when behavior changes.

Default validation checklist before opening a PR:

- `pnpm check-types`
- `pnpm lint`
- `pnpm test` (when behavior changes)

Pre-commit runs ESLint and Prettier via Husky + lint-staged. Do not bypass with `--no-verify`.

## Code style

- Prettier (`.prettierrc`) and ESLint (`eslint.config.mjs`) are authoritative — let them format. Imports are sorted by `@trivago/prettier-plugin-sort-imports`.
- TypeScript strict mode. Prefer explicit types on exported APIs; let inference handle locals.
- ESM only (`"type": "module"`). Use `import`/`export`, never `require` in source.
- Logging goes through `src/utils/logger.ts` (`logger.info` / `logger.warn` / `logger.debug` / `logger.error`). Do not use `console.*` in `src/`.
- Avoid emojis in source, logs, and commit messages unless the user requests them.

## Editing conventions

- Prefer editing existing files over creating new ones.
- For behavior changes, review and update existing user-facing docs first (especially `README.md`) instead of creating new docs unless clearly needed.
- Don't add comments that restate the code. Reserve comments for non-obvious _why_ (constraint, workaround, surprising invariant).
- Don't add backwards-compatibility shims, dead exports, or "// removed" markers when deleting code — just remove it.
- Don't introduce new abstractions or refactors outside the scope of the requested task.
- Validate at system boundaries (request handlers, external APIs). Trust internal calls.

## Tests

- Tests live under `src/test/` and use Mocha + Node `assert`. Match the existing `suite` / `test` style.
- Add tests for new request-conversion logic, new route behavior, and any bug fix with a reproducible case.
- UI/extension-host behavior cannot be covered by unit tests alone — if the change affects VS Code commands or UI, say so explicitly rather than claiming verification.

## Commits, changesets, and releases

- Commit message style follows Conventional Commits (`fix(scope): …`, `feat(scope): …`, `refactor: …`). See `git log` for examples.
- **Every user-visible change needs a changeset.** User-visible includes anything users can see or feel (UI text/behavior, API behavior, bug fixes, performance improvements). Developer-only internal changes (e.g., tests-only updates or refactors/tooling changes with no user-facing effect) generally do not need a changeset. Run `pnpm changeset`, pick `patch` / `minor` / `major`, and commit the generated file in `.changeset/`.
- Release flow: a maintainer runs `pnpm changeset:version` (bumps `package.json`, regenerates `CHANGELOG.md`, deletes consumed changesets) and opens a release PR. Agents should not bump versions or edit `CHANGELOG.md` directly unless explicitly asked to cut a release.
- Never force-push, never push directly to `main`, and confirm before pushing any branch.

## Risky actions — confirm first

Ask before doing any of these, even if a prior similar action was approved:

- `git push`, force-push, branch deletion, tag creation.
- Editing CI workflows in `.github/`.
- Publishing to VS Code Marketplace / Open VSX (`publish:vs-marketplace`, `publish:open-vsx`).
- Deleting or rewriting `.changeset/` entries, `CHANGELOG.md`, or version fields.
- Adding, removing, or bumping dependencies, or changing package/runtime versions.

## Pull requests

- Keep PRs scoped to one logical change. Split release-prep commits from feature/fix commits.
- PR title mirrors the primary commit (`fix(anthropic): …`).
- PR body: short summary + test plan checklist. Reference the changeset.
