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

## HTTP authentication across windows

After `pnpm build-tests`, run `node scripts/test-http-auth-windows.mjs <absolute-vscode-executable>`. It opens two isolated profiles, uses a temporary policy and dummy keys, and exercises the actual configuration command and ProxyServer admission. Quick-pick/input answers and the explicit disable confirmation are supplied by the harness; it does not verify visual command-palette layout. SecretStorage is deliberately in-memory to verify that it does not control the policy.

The harness verifies setup, key rotation, explicit disable, deleted/corrupt policy, and permission recovery, then closes its test windows. It prints the location of logs and JSON results. It does not configure the normal user's authentication file or consume model quota.

Client-configuration tests in `src/test/server/clientConfigurators.test.ts` invoke each real configurator with temporary user/project paths and a real verifier policy. They validate emitted credentials, rejection/cancellation, stale-key replacement, and unrelated settings preservation. `src/test/utils/portUtils.test.ts` exercises legacy detection and monitored takeover. They do not launch the four external clients or exercise enterprise-managed overrides.
