# Testing Guide

Use the Node/pnpm versions in [package.json](../package.json). Tests use Mocha and an extension host via `@vscode/test-cli`; dependencies must be installed before running them.

## Commands

Run from the repository root:

```bash
pnpm check-types
pnpm lint
pnpm test
```

`pnpm test` compiles tests, type-checks/builds the extension, runs lint, and launches the VS Code test host. Use type-check/lint during editing, then the full suite for behavior changes. For tests-only iteration, `pnpm build-tests` refreshes compiled tests and `pnpm watch-tests` watches them.

The checked-in [.vscode-test.mjs](../.vscode-test.mjs) selects `out/test/**/*.test.js`. If the host cannot start (for example, a missing cached executable), fix the test-host installation or select a verified local installation with a temporary test-runner configuration. A launch failure is not a passing test run; do not commit machine-specific paths.

## Suite Map

| Area under `src/test`                                                     | Coverage                                                       |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [extension.test.ts](../src/test/extension.test.ts)                        | Activation and registered commands                             |
| [schemas](../src/test/schemas/)                                           | Request schema validation                                      |
| [utils](../src/test/utils/)                                               | Configuration, models, images, and shared helpers              |
| [server](../src/test/server/) conversion suites                           | Anthropic, Chat, Responses, and Gemini message/tool conversion |
| `server/toolHistory*.test.ts`                                             | Shared normalization and official SDK stream compatibility     |
| `server/*WebSearch.test.ts`                                               | Hosted/standalone search, provider limits, and isolation       |
| `server/sseHeartbeat.test.ts` and `languageModelRequestLifecycle.test.ts` | Heartbeats, cancellation, timeouts, and stream ordering        |

Use the test runner's output for current counts; parameterized suites make manually maintained totals unreliable.

## Adding Tests

Follow existing `suite` / `test` conventions with Node `assert`. Cover the observable regression, restore mocks/listeners in cleanup hooks, and use isolated temporary files/ports. Do not make ordinary tests consume external model or Exa quota. See [AGENTS.md](../AGENTS.md#tests) for required coverage.

## Manual Validation

Unit tests do not prove UI behavior or live provider compatibility. Record the AM revision, VS Code/client versions, model, isolated ports, expected output, and relevant AM logs for manual runs. Avoid sharing raw request/session logs without applying the [logging guidance](llm-compatibility.md#diagnostic-logs).

- Use the [Codex collaboration runbook](codex-multi-agent-e2e.md) for Responses namespace/plaintext collaboration changes.
- Recheck [image MIME behavior](vscode-image-mime-defect.md) when changing the VS Code engine.
- For documentation-only edits, check links, anchors, examples, and diagrams. Build the website if its source changes; model requests and a full extension-host run are unnecessary unless behavior also changes.

## Pre-release Live CLI Regression

This opt-in check consumes Copilot model quota. It complements extension-host tests; do not add it to ordinary `pnpm test` or run it automatically without approval.

### Prepare the host and fixture

1. Record the candidate commit, AM version, VS Code build, bundled Copilot version, all three CLI versions, and the exact model IDs. Use the intended release host; testing Insiders does not establish compatibility with stable VS Code.
2. Build the candidate and launch its **full extension** in a dedicated VS Code development window. Use an empty window so proxy error diagnostics cannot write into the inspected repository. A route-only harness does not cover extension activation, authentication, or the full proxy server.
3. Set unused ports through `AGENT_MAESTRO_PROXY_PORT` and `AGENT_MAESTRO_MCP_PORT`, and verify the actual listener. Leave existing AM windows and services untouched. Check `/openapi.json` and `/api/v1/lm/chatModels`, and confirm the resolved models use the intended provider.
4. Record the fixture repository's commit and working-tree status. Obtain any required workspace-trust approval; VS Code and the CLIs maintain separate trust state. Do not silently trust a folder or bypass tool permissions.
5. Record the [Copilot cache mode](copilot-gpt-prompt-cache.md). Recommend implicit mode for AM's GPT requests, but never change shared User/Workspace settings without approval. If the user keeps an unset value, record the mode as unknown rather than inferring it from the visible default.

Use loopback URLs and per-process configuration. If AM authentication is enabled, use a matching temporary test key; a dummy value only works when no AM key is configured. Never record keys, authorization headers, or credentials.

### Exercise all three clients

Use an available model from the appropriate family for each protocol:

| Client      | AM base URL                             | Expected inference endpoint                                    |
| ----------- | --------------------------------------- | -------------------------------------------------------------- |
| Codex CLI   | `http://127.0.0.1:<port>/api/openai/v1` | `POST /api/openai/v1/responses`                                |
| Claude Code | `http://127.0.0.1:<port>/api/anthropic` | `POST /api/anthropic/v1/messages`                              |
| Gemini CLI  | `http://127.0.0.1:<port>/api/gemini`    | `POST /api/gemini/v1beta/models/<model>:streamGenerateContent` |

For Codex, use a temporary Responses provider or `--config` overrides, `--ignore-user-config`, `--ephemeral`, `--sandbox read-only`, and `--json`. For Claude Code, set `ANTHROPIC_BASE_URL` and the test authentication variables; use read-only tools such as `Read,Grep,Glob` and streaming JSON output. Where supported, `--bare`, `--restricted`, and `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` avoid unrelated hooks, plugins, and MCP servers. Do not use approval-bypass modes.

For Gemini, set `GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_KEY`, and the model, then use `--approval-mode plan` and `--output-format stream-json`. Disable unrelated extensions (`--extensions none` in the tested CLI). Verify that trust checks have not downgraded plan mode. With an isolated `GEMINI_CLI_HOME`, the tested CLI stores its main settings at `<GEMINI_CLI_HOME>/.gemini/settings.json`, not directly under that directory; API-key authentication uses `security.auth.selectedType: "gemini-api-key"`. Recheck these version-specific settings when updating the CLI. Authentication or trust failures before an HTTP inference request are client-setup blockers, not proxy failures.

Give each client the **same user prompt** against the same fixture revision. Keep normal client system prompts and tool schemas; this is a compatibility test, not a model-quality benchmark. One suitable prompt is:

```text
Perform a bounded, read-only security inspection of this checkout.
Follow one MCP tool-invocation flow through its input, approval/trust checks,
and execution or resource-access endpoint. Inspect at most 10 source files.
Use only local source reads and searches. Do not modify files or settings,
run builds/tests/application code or exploits, install anything, start agents
or services, use network tools, or access credentials/private user data.
Report up to five file/line references, any limitations, and only vulnerabilities
whose reachable unauthorized impact is established. Otherwise say no vulnerability
was established within this inspection. Return the report without writing a file.
```

Aim for a few minutes of real work, with an externally enforced limit of five minutes per client. Allow independent read-only runs in parallel, but do not create artificial waits or extra model calls merely to reach a duration. Preserve failed attempts separately from retries.

### Inspect protocol and cache evidence

- Correlate each client's transcript with the **Agent Maestro** Output log using timestamps and endpoint paths. Prefer info-level logs; debug and error diagnostics can contain request content.
- Require actual local source-reading tool calls and a final client result, not just process exit code zero. Check HTTP status, stream termination, tool-call/result continuation, malformed frames, retries, and premature disconnects. Report review depth separately: a successful transport is not a complete security audit.
- Confirm that all inference requests use AM. Record optional non-inference probes separately; a client that tolerates an unsupported probe is different from a failed model request.
- Collect usage for every model round. Responses uses `input_tokens_details.cached_tokens`, Anthropic uses `cache_read_input_tokens` (and cache creation), and Gemini uses `usageMetadata.cachedContentTokenCount`. Compare these with AM's `cache_read` logs.
- A positive cache-read count on a later round establishes reuse. Initial zeroes can be warm-up; changing prefixes can also miss. Persistent zeroes need investigation, but AM can normalize omitted usage or local estimates to zero. GPT `cache_write: 0` can be a placeholder and does not prove that caching is disabled.
- Do not double-count cached input. Responses input already includes it; Anthropic input excludes cache reads/writes, and the current Gemini adapter excludes cached tokens from `promptTokenCount`. Account for each adapter's mapping before calculating ratios. Do not compare ratios across clients as if they had identical system prompts, tool schemas, or model behavior.

Record a small results table: client/model/version, elapsed time, completed tool calls, inference requests and errors, cache-read sequence, and completion/timeout/blocker. Keep raw transcripts local and follow the [logging guidance](llm-compatibility.md#diagnostic-logs) before sharing evidence.

### Finish

Verify the fixture's working tree is unchanged; do not revert unrelated user changes. Stop only the test-owned proxy, observer/recording helpers, CLI processes, and development window. Restore any settings changed with approval, and remove only test-owned temporary profiles. Do not leave listeners running or publish a release as part of this check.
