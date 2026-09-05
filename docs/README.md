# Documentation Index

Start with the [project README](../README.md) for installation and client setup. Current guides describe the checked-out implementation; [CHANGELOG.md](../CHANGELOG.md) records released versions, and [.changeset](../.changeset/) holds unreleased notes. A design marked implemented is not by itself a Marketplace release announcement.

## Current Guides

| Guide                                                    | Use it for                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [LLM compatibility](llm-compatibility.md)                | Endpoint examples, content/history support, search differences, usage, and log privacy |
| [OpenAI Responses](openai-responses-api-design.md)       | Responses-specific support/rejection rules and streaming semantics                     |
| [Roo HTTP/SSE](roo-routes-events.md)                     | AM task endpoints, event payloads, and completion rules                                |
| [Roo extension API notes](roo-code/README.md)            | Upstream API boundary and pinned type references                                       |
| [Context-window handling](claude-code-context-window.md) | Copilot prompt budgets and Claude Code compaction                                      |
| [SSE heartbeats](2026-08-11-sse-heartbeats.md)           | Authoritative heartbeat formats and serializer constraints                             |
| [Image MIME workaround](vscode-image-mime-defect.md)     | Top-level resize workaround and Anthropic tool-result exception                        |

The running `/openapi.json` supplies route schemas. It complements these guides; permissive LLM body schemas do not imply support for every upstream option.

## Runbooks and Contribution

- [Testing](testing.md): local checks, suite locations, and manual validation.
- [Codex collaboration E2E](codex-multi-agent-e2e.md): authenticated manual test.
- [Remote Roo demo](../examples/demo-site/README.md): local UI and protected remote access.
- [Contributor instructions](../AGENTS.md), [release procedure](../.claude/commands/release.md), and [issue tracker](agents/issue-tracker.md).
- [Code-review workflow](../.github/skills/code-review/SKILL.md).

## Design Records

These explain why a feature was built or deferred. Their status blocks identify the baseline and current guide; historical proposals are not instructions to restore old code.

| Record                                                                                             | Status                                                                            |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [Gemini routes, 2025-11-15](2025-11-15-gemini-routes-design.md)                                    | Historical proposal; generation shipped in v2.4.0, counting/history later changed |
| [Native VS Code proxy survey, 2026-07-10](2026-07-10-vscode-openai-language-model-proxy-survey.md) | Dated upstream survey; proposed v2 integration, not implemented                   |
| [Anthropic search, 2026-08-26](2026-08-26-anthropic-server-web-search-design.md)                   | Implemented; released in v2.13.0                                                  |
| [Responses search, 2026-08-30](2026-08-30-openai-responses-web-search-design.md)                   | Implemented in #243; consult release notes for availability                       |
| [Codex standalone search, 2026-08-31](2026-08-31-codex-standalone-web-search-design.md)            | Implemented in #247, including open/find and configuration gate                   |
| [Tool-history normalization, 2026-09-04](2026-09-04-tool-history-normalization-design.md)          | Implemented in #252; current-checkout history rules                               |

## Maintaining Documentation

Update the relevant current guide when behavior changes. Keep setup instructions in the project README, heartbeat frames in the heartbeat note, and full protocol rationale in the design records. Link instead of copying type inventories, test counts, or long configuration examples. Keep source diagrams and their rendered images synchronized.
