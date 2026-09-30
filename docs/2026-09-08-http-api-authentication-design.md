# Shared HTTP API authentication

Status: implemented and validated on 2026-09-08; design self-review was completed before implementation. Baseline: `f6efa9b`, issue [#257](https://github.com/Joouis/agent-maestro/issues/257). Implementation results appear below.

## Problem and scope

The optional LLM key protects only provider routes. Control endpoints under `/api/v1`, including `/info`, file access, workspace changes, and Roo/Cline tasks, are public. `/info` reveals the home and workspace paths.

Protect all four HTTP API families with one authentication policy. Preserve provider-specific headers and errors, and add a public, minimal `/health` endpoint for discovery. The MCP server still requires separate access controls. The HTTP bind address is unchanged.

## Decisions

### One durable record

Persist policy and a **salted scrypt verifier**, rather than the raw key, together in `~/.agent-maestro/http-auth.json`. The server verifies incoming keys; it never needs to recover or forward its key. The server does not persist raw keys in SecretStorage, its policy file, or logs. Client configurators save the explicitly re-entered and verified credential in each client’s private configuration file.

The scope is the **operating-system user on the extension-host machine**. All AM windows, profiles, ports, and VS Code installations under that user share the record, including Stable and Insiders. Remote extension hosts use their remote user's home directory. Different users and machines have independent records. Do not derive application-wide paths from profile-scoped VS Code directories.

Disabled record: `{version: 1, mode: 'disabled'}`. Enabled record: `{version: 1, mode: 'enabled', salt, hash}`. On disk these are JSON. Salt is 16 random bytes encoded as lowercase hex; hash is 32 bytes encoded as lowercase hex. Use asynchronous Node scrypt with fixed `N=16384`, `r=8`, `p=1`. File contents cannot select KDF costs. Compare derived bytes with `timingSafeEqual`.

Create the directory with mode `0700`, new files with `0600`. On POSIX, require a non-symlink directory owned by the current user, and reject directories or records accessible to group/other users. Windows relies on the home-directory ACLs; POSIX bits are not Windows ACL enforcement. Reject non-regular files, invalid shapes, unknown versions, and files over 4096 bytes.

### Explicit states and setup

| State       | Meaning                                                              | API behavior                                   |
| ----------- | -------------------------------------------------------------------- | ---------------------------------------------- |
| Enabled     | Valid enabled record                                                 | Correct key passes; missing/wrong key gets 401 |
| Disabled    | Valid disabled record                                                | Requests pass without a key                    |
| Unavailable | Missing/unreadable/malformed record, or verification cannot complete | 503; health/spec remain public                 |

First use and upgrades require an explicit choice using **Agent Maestro: Set API Key**: set a key, import the previous LLM key, or disable HTTP authentication. Canceling leaves authentication unavailable. A readable legacy key may be imported by explicit choice; absent or unreadable legacy storage never means consent to disable.

This is a deliberate onboarding change. Automatic unauthenticated startup cannot reliably distinguish a new installation from unavailable/lost credentials. The extension activates and serves health/spec before setup, with an actionable notification.

### Read the authoritative record on every request

No SecretStorage listener, globalState flag, filesystem watcher, polling timer, or in-memory policy setter controls admission. Each API request reads the small file. Windows share the same source without event ordering or profile-cache dependencies.

Cache at most one successful verification, indexed by the complete record and an HMAC of the supplied key using a process-local random cache key. Never reuse it when the record cannot be read or changes. Missing headers and keys exceeding 1024 bytes are rejected before scrypt. Limit active distinct verifications to two, with eight bounded FIFO waiters; identical pending verifications share their derivation. A new uncached valid key waits behind a short burst of incorrect keys instead of immediately failing. A full queue returns a busy 503 with `Retry-After: 1`, distinct from setup/recovery errors. Valid and invalid keys cannot be distinguished before verification, so sustained unauthenticated traffic may still exhaust this bounded capacity; deployment-level rate limits are needed for stronger availability guarantees. No failed-key cache.

After an asynchronous derivation, read the record again. If it changed, return 503 for retry rather than admit against stale credentials. Requests already admitted may finish, including SSE streams; changing authentication does not cancel existing work.

### Atomic changes

Set/rotate and disable each publish a complete record: create a unique temporary file in the same directory, write/flush/close it, then atomically rename it. Clean temporary files on failure. **Never delete the current record to disable.**

Rename is the commit point. Earlier reads see the old policy; later reads see the new one. Failure before commit preserves the old file. Concurrent windows use last committed rename wins; no split transactions or rollback writes. A later explicit configuration can supersede an earlier successful one. Never report success before commit.

A missing/corrupt record can be replaced through an explicit configuration action. Read failures recover on subsequent requests when storage becomes readable.

## Integration and migration

Keep command ID `agent-maestro.setLlmApiKey`, rename its title **Set API Key**. Offer set/replace, disable, and (only when unavailable) import the previous key. Use password input; blank input is invalid because disabling is a separate action. Accept printable ASCII keys up to 1024 bytes, without surrounding whitespace.

Import reads `agent-maestro.llmApiKey` only after that choice. It publishes the same verifier record. Missing, unreadable, or invalid legacy keys leave the policy unchanged and require a new key. Do not delete the old key automatically: other installations may still use it. Old AM versions do not participate; update/reload windows still serving older versions.

ProxyServer receives an injectable authentication service, used by middleware and configuration commands. Remove raw in-memory getters/setters and startup key restoration. The core service uses Node filesystem/crypto and no VS Code imports, UI, listeners, or timers. A constructor path override isolates tests; production uses the fixed host-user path, not a workspace-controlled setting.

## HTTP contract

| Prefix             | Credential                    | Error envelope                            |
| ------------------ | ----------------------------- | ----------------------------------------- |
| `/api/v1/*`        | `Authorization: Bearer <key>` | `{message: ...}`; Bearer challenge on 401 |
| `/api/openai/*`    | `Authorization: Bearer <key>` | OpenAI                                    |
| `/api/anthropic/*` | `x-api-key: <key>`            | Anthropic                                 |
| `/api/gemini/*`    | `x-goog-api-key: <key>`       | Gemini                                    |

Unavailable state returns protocol-shaped 503 with an actionable generic message, never paths or supplied keys. One middleware is parameterized by protocol. Keep CORS first so OPTIONS preflight works without executing protected handlers.

`GET /health` returns only `{"name":"Agent Maestro","status":"ok"}`: listener existence, not model/authentication readiness. Port discovery uses it. Only a 404 triggers a credential-free legacy `/api/v1/info` fallback; identifying a legacy listener keeps port monitoring active and warns that the old process does not enforce the new policy. Public `/openapi.json` describes conditional authentication and 401/503 responses. `/info` keeps its existing response behind control authentication.

Update README onboarding/access, compatibility examples, Roo/demo instructions, documentation index, and a major changeset. No dependency/runtime or MCP changes.

## Threat and failure boundaries

- A remote caller reaching the listener cannot execute protected handlers unless the durable record explicitly disables authentication or a key verifies.
- Same-OS-user processes can replace policy/files and are outside this boundary. Verifiers still avoid plaintext credential storage.
- SecretStorage swallows some decryption failures and may switch to empty memory storage when encryption is unavailable. Neither controls established policy.
- Missing files, permission/I/O errors, malformed data, and truncated records fail closed. Require a local filesystem supporting atomic same-directory rename.
- TLS, MCP authentication, and older AM processes are outside scope. Remote deployments still need TLS and network access controls.

## Design self-review before implementation

Reviewed for correctness, security, simplicity, failure recovery, concurrency, and previous reproductions. Resolved before implementation:

1. Ambiguous missing secrets: no automatic disabling or migration; explicit setup/import.
2. Storage scopes/event ordering: one host-user record; no event-driven admission.
3. Raw keys on disk: persist only a salted verifier.
4. Two-phase writes/rollback races: complete atomic records, last commit wins.
5. Stale positive cache: bind to complete record, reread each request and after asynchronous verification.
6. KDF denial of service: bound key size and concurrent work; no unbounded queues/caches.
7. Verification claims: test independent processes and real VS Code windows separately.

A disable selection requires a modal confirmation identifying the network exposure and host-user scope. Unsafe existing directory permissions fail closed with the exact directory and 0700 remediation in the local command error; no automatic chmod is performed.

No unresolved design blocker for this boundary. Explicit setup and host-user scope are intentional compatibility decisions.

Sources checked: [VS Code data storage](https://code.visualstudio.com/api/extension-capabilities/common-capabilities), [remote-extension storage](https://code.visualstudio.com/api/advanced-topics/remote-extensions), and [VS Code 1.136.1 SecretStorage implementation](https://github.com/microsoft/vscode/blob/1.136.1/src/vs/platform/secrets/common/secrets.ts).

## Validation plan

- Core: missing/disabled/enabled; wrong key; malformed/version/permissions/size; failed publication; rotation; deleting a cached record; recovery; concurrent writes; verification limits.
- Routes: enumerate API methods; 503 before setup, 401 when enabled; valid credentials; all protocol envelopes; health/spec/preflight.
- Commands: explicit import (readable, missing, rejected), cancellation, disable, persistence failure.
- Independent processes sharing a temporary record: enable, rotate, disable, corruption/deletion and recovery.
- Two real VS Code windows with different profiles and one temporary record: updates affect the serving window without SecretStorage events. Dummy keys and isolated user data only.
- Type-check, lint, build, full VS Code suite. Record platform limits.

## Implementation results

- Implemented `FileHttpAuthentication`, protocol-specific middleware, public discovery, explicit setup/import, and current-guide updates. No raw key setter, SecretStorage subscription, or split state remains.
- Design and implementation self-review covered policy/key scope, missing-store behavior, publication failure, stale cache, file permissions, migration, concurrency, and protocol boundaries. No unresolved blocker was found within the stated threat boundary.
- Type-check, lint, build, and full isolated VS Code 1.136.1 suite passed: 619 tests after the additional review fixes. The latest count includes five new regressions and removes eleven obsolete crypto-helper tests. Earlier middleware tests were replaced with shared-service and route integration tests.
- An independent child-process test verifies that rotation and missing-policy recovery are observed without events.
- `scripts/test-http-auth-windows.mjs` passed on macOS with two real VS Code profiles and independent extension hosts. It invoked the real Set API Key command with supplied quick-pick/input answers: enabling in the peer produced 401 without a key and 200 with the key in the owner; rotation rejected the old key; deletion/corruption produced 503; explicit disable restored 200; unsafe file permissions produced 503 and recovered after correction. Health remained public. SecretStorage was deliberately forced to in-memory mode.
- This verifies command execution and admission across actual hosts, not the visual layout of input dialogs. Windows ACLs, Windows rename behavior, and remote hosts were not exercised on this macOS machine.

Reproduce using the [testing guide](testing.md#http-authentication-across-windows). The harness uses an injected temporary policy path so it never changes the normal user's policy. The production default path is fixed in the service.

## Accepted review follow-up

This work originated in #257 but implements the explicitly approved broader authentication redesign. Its scope includes all HTTP API families, host-user durable policy, mandatory setup, migration, and client integration. It is a major-version change because v2.14 clients receive 503 until setup is completed.

The client configurators query the policy, stop on unavailable state, and ask for the current key when enabled. Input is validated against the verifier before any client file is written. Cancellation or an invalid key leaves files unchanged. Disabled policy uses the existing placeholder convention. Client files contain raw credentials by necessity; the server still retains only a verifier. New/existing credential files use mode 0600 on POSIX. Project Claude credentials use `settings.local.json`; project Gemini `.env` must stay out of source control.

Claude uses `ANTHROPIC_API_KEY` and blanks the bearer override. Codex uses the documented static `http_headers.Authorization` field to avoid an extra shell setup step, removes competing authentication sources only in its AM provider, and documents `env_key` as the optional alternative. Gemini replaces stale `GEMINI_API_KEY` values using lossless dotenv quoting and reports any key it cannot encode. Desktop writes the verified `inferenceGatewayApiKey` and explicitly selects `inferenceGatewayAuthScheme = "x-api-key"`, because the client otherwise defaults to bearer authentication. Environment, project, and enterprise-managed overrides remain subject to client precedence rules.

Mixed-version discovery only falls back after `/health` returns 404. It sends no credential, bounds response size/time, accepts the legacy AM service identity, and keeps monitoring until takeover. It never represents discovery of an older version as evidence that authentication is enabled there.

Follow-up validation covers all four actual configurator handlers writing temporary files, credential verification at protocol boundaries, wrong-key/cancel/unconfigured aborts, private permissions, stale credential removal, project Claude local settings, and unrelated provider preservation. Legacy takeover is tested with a real HTTP listener and the actual monitor callback (without waiting a full minute). These tests do not claim end-to-end execution of all four external client applications. Current client fields were checked against their official documentation.

The PR description is prepared separately from durable design documentation; no PR has been created for this local branch.

## Additional review resolution

- Added regression coverage for a stale shared `.claude/settings.json` beneath the generated project-local file, plus an official Anthropic SDK request using the resulting API key and empty bearer value. The shared file is preserved; project-local precedence supplies the effective value. This is not a live Claude Code precedence test.
- Bounded FIFO verification, busy retry guidance, explicit disable confirmation, actionable directory recovery, and obsolete crypto-helper cleanup were accepted. Reverse-direction discovery by an old binary remains an upgrade limitation; `/api/v1/info` is not made public to accommodate old code.
- PR-body working material is kept outside the repository. The leading blank line in newly created Gemini dotenv files is cosmetic and is not part of the authentication fix.

Additional-review validation: `pnpm check-types`, `pnpm lint` (via build), `pnpm build`, and the full isolated VS Code 1.136.1 suite passed. The two-real-profile harness also passed again with the required disable confirmation supplied by the test harness. This validates the actual command path and shared policy but not the visual layout of the modal or a live Claude Code process.
