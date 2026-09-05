# Tool History Normalization Design

## Status and Scope

Implemented and validated on 2026-09-05 in [#252](https://github.com/Joouis/agent-maestro/pull/252). Baseline recorded on 2026-09-04: `main` at `f041fe1`, which includes [#251](https://github.com/Joouis/agent-maestro/pull/251). This is a design record; see [LLM compatibility](llm-compatibility.md#content-tools-and-history) for the current user-facing summary.

Unify **inbound history normalization** across Anthropic Messages, OpenAI Chat Completions / Responses (including custom tools), and Gemini GenerateContent. The goal is to send complete tool-call/result pairs to VS Code LM while preserving useful task progress.

Normalize only the history supplied in the current request. Do not execute tools, modify client session files, or process tool calls that the model is still generating. SSE, retries, authentication, and model selection are outside this scope. Gemini Live / NON_BLOCKING incremental results do not fit this finite-history model and must not be treated as replay duplicates.

Normalization runs on a decoded history snapshot before an upstream model request, never on the outbound response stream. End-of-request finalization means the end of that input snapshot, not completion of a live tool execution.

## Core Decisions

**Identify complete tool-call turns and pairs before deciding what to preserve, convert to context, or deduplicate.** These rules replace the earlier global `seenResultIds` approach that deleted results as they arrived.

| Situation                                                                     | Content sent to the model                                                               | Rationale                                                                                      |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Unambiguously matched call and result                                         | Preserve the complete pair; error results and explicitly empty results count as results | Tool failure is different from a missing result                                                |
| Call without a result                                                         | Remove the formal tool call and retain a short execution-status-unknown note            | A missing result does not prove the tool did not execute; avoid repeated submissions or writes |
| Result without a call                                                         | Preserve the result as ordinary context with a provenance marker                        | Retrieved information, file locations, and computed values may still be useful                 |
| Same turn, same ID, identical results                                         | Keep one result                                                                         | The information is identical and does not require multiple tool results                        |
| Same turn, same ID, different results                                         | Convert the associated calls and results to ordinary context with a conflict note       | Do not infer the final result from ordering or length, or invent an unambiguous pair           |
| Complete call/result pairs replayed across turns                              | Preserve each pair, remapping upstream IDs when necessary                               | Matching IDs and content do not prove that these were not separate executions                  |
| Repeated calls within a turn with the same ID, tool name, type, and arguments | Merge the calls and handle their results together under the rules above                 | Calls and results must be evaluated as a group                                                 |
| Repeated ID within the same tool type/turn with different names or arguments  | Convert the related calls and results to conflict context                               | The ID does not uniquely identify a call; do not choose arbitrarily                            |

Typed Responses function/custom outputs distinguish their namespaces, so complete pairs can reuse an ID across those types. An untyped result that could match both types makes the associated groups conflicting.

Ordinary context remains historical data with explicit provenance. It is not a new user instruction and must never be promoted to system/developer instructions. Preserve unrelated text/images and their relative order. The output renderer combines same-turn call/result messages and keeps parallel formal tool parts contiguous, followed by ordinary content from that message group: Copilot rejects text interleaved between parallel results. Nothing moves across a turn boundary. Omit a message only when all its content has been explicitly removed.

### Calls Without Results: What to Retain

AM cannot reliably determine whether an arbitrary third-party tool has side effects, nor does it have a reliable not-executed marker. The first version therefore does not infer whether a call can be discarded from names such as `read_*`.

- Remove the formal `ToolCallPart` and full arguments to avoid dangling calls and large inputs with no result.
- Combine missing results into one short note per tool-call turn, for example: `[Incomplete tool history: submit_expense has no recorded result. Execution status is unknown; verify before retrying.]`
- Count repeated tool names rather than listing them repeatedly. Retain only bounded tool names/call references, excluding credentials, request bodies, and full arguments. The note asserts neither that execution occurred nor that it did not.
- A content-free call with no tool name, valid ID, usable arguments, or other interpretable information may be omitted. If reliable not-executed/cancelled status becomes available later, define separate conditions for omitting the note.

### Results Without Calls: Preservation and Compression

The first version **preserves information while reducing wrapper overhead**, without another LLM summarization step:

- Preserve text, structured output, error details, and images/media already supported by the adapters. Do not automatically discard `0`, `false`, explicitly empty containers, or status strings as noise.
- Identify the known tool name, original call reference, and missing match. Do not infer the original arguments or synthesize a tool execution that is absent from history.
- Remove redundant protocol wrappers. Identical orphaned results with the same explicit source ID within one turn may be merged. Without an ID, do not deduplicate by content or tool name.
- Reuse existing media converters and limits; do not serialize base64 into ordinary text. Adding format support is outside scope. Preserve existing masked/truncated text and acknowledge its incompleteness.
- Do not truncate result bodies by default or claim to identify useful passages automatically. Existing context limits still apply to the whole request. Lossy summaries, cross-task caching, and additional automatic truncation policies require separate evaluation.

Orphaned results may therefore still consume substantial tokens. This avoids trading an unverified compression rule for silent information loss.

This is not a reversal of #251: that fix already preserves complete pairs across turns and removes repeated results within a call turn. Preserving conflicting result bodies as context can, however, increase input size compared with its first-result-wins behavior. Compare serialized size and input token counts on the retained resume fixtures; do not assume every resume becomes larger or claim universal token savings.

## Pairing, Turns, and IDs

### Turn Boundaries

Adapters identify tool-call turns before role conversion or message merging: a group of consecutive assistant/model call messages followed by their result messages. Consecutive OpenAI Responses call items belong to one group; function and custom tools use separate matching types.

- A new assistant/model turn, independent user input without tool results, an instruction boundary, or the end of the request closes the current turn.
- When a user message mixes results with text or images, its results still belong to the current turn. Other content is retained in relative order within that turn, subject to grouping formal tool parts for the serializer as described above.
- Results can match only calls already encountered in the current turn. They cannot cross boundaries, match future calls, or connect separate turns merely because tool names match. Late results become orphaned context.
- Finalize missing results only when the turn closes. Receiving the first result does not mean other parallel calls are missing their results.
- Do not attach a result across a subsequent assistant message, even if that message contains only text. Without reliable turn information, preserve context rather than moving historical messages to manufacture a pair.

### Explicit IDs and Missing IDs

Use `(turn index, tool type, call occurrence index)` as the internal identity. The original protocol ID is a matching hint. Typed Responses function/custom outputs distinguish their respective namespaces; if an untyped result could refer to calls of both types, treat the group as conflicting rather than selecting one.

1. Match valid explicit IDs within the current turn first. If a result includes a tool name, the name must also match. Unknown/conflicting IDs must not fall back to forced name matching.
2. Gemini permits omitted IDs. Explicit results reserve their matching calls first; then assign ID-less results in FIFO order to unmatched calls with the same name. This is a deterministic recovery rule for mixed formats, not proof of execution provenance.
3. Two ID-less calls to the same tool remain separate pairs even when their arguments/results are identical. Excess ID-less results become orphaned context. Do not infer that an unknown explicit result ID belongs to an ID-less call solely from the tool name.
4. Do not add name-based missing-ID recovery for Anthropic or OpenAI. Content that cannot be located unambiguously is handled as missing or conflicting.
5. Every retained pair receives a unique ID in the upstream request. Preserve the original ID when it is usable and globally unique within that request. For ID reuse, cross-tool-type collisions, or Gemini calls without IDs, generate deterministic local IDs and rewrite both sides of each pair. Reserve all explicit input IDs to avoid collisions with generated IDs.

Historical ID remapping applies only to the normalized copy sent in the current upstream request. The normalizer does not mutate client input or session files, and its mapping is not used by response serializers. Newly generated tool-call IDs follow the existing outbound conversion and are persisted by the client as usual; the next request is normalized independently. No reverse mapping or persistent ID registry is introduced.

**Do not deduplicate content across turns.** Identical IDs and content may represent a replay or another execution. Without sufficient execution identity, preserving complete pairs is more reliable than deleting one side or guessing which occurrence is authoritative.

Conflict context includes the tool name and necessary call information, states that the relationship cannot be determined, and avoids repeating large arguments. Unknown or invalid IDs must not create state that affects later turns. These rules do not claim to recover the true execution semantics of damaged history; they prevent normalization from inventing a successful pairing.

## Required Examples

`C` denotes a call, `R` a result, and `→` the original order. Brackets identify turns; a call after a result starts a new turn. Ordinary context stays in its original turn and retains its relative order, subject to grouping parallel formal parts for the upstream serializer.

| Input history                                            | Expected output                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `C(x) → R(x)`                                            | One complete pair                                                                           |
| `C(x)` followed by the end of the request                | One result-unknown note, no formal tool call                                                |
| `R(x)`                                                   | Result context with a provenance marker                                                     |
| `R(x) → C(x) → R(x)`                                     | Earlier result becomes context; later pair remains valid, without orphan state poisoning it |
| `C(x) → R(x) → R(x)`, identical results                  | One complete pair within the turn                                                           |
| `C(x) → R(x, a) → R(x, b)`, different results            | Conflict note and both results as context, no formal pair; no first/last-wins rule          |
| `[C(x) → R(x)] → [C(x) → R(x)]`                          | Two complete pairs in different turns; use distinct upstream IDs                            |
| `[C(x), C(x) → R(x), R(x)]`, identical calls and results | One complete pair in the same turn                                                          |
| `[C(x), C(x) → R(x, a), R(x, b)]`, different results     | Conflict context for the whole group, no formal pair                                        |
| Parallel `C(a), C(b)` followed by `R(b), R(a)`           | Pair by ID and preserve both results                                                        |
| `C(a), C(b)` followed only by `R(a)`                     | Preserve pair a; replace call b with a result-unknown note                                  |
| Two ID-less `C(f), C(f)` followed by one `R(f)`          | Pair the first call by FIFO; replace the second with a result-unknown note                  |
| ID-less `C(f) → R(f), R(f) → C(f) → R(f)`                | First turn has one pair plus orphaned context; second turn still pairs normally             |

## Implementation Design

Replace the tracker's global seen-set decisions with a **pure, request-local history normalization stage**, rather than reusing the incremental state-machine patches from the earlier unmerged work.

Pipeline: `protocol decoding and turn annotation → pairing and group decisions → VS Code message generation`.

### Responsibilities

| Layer             | Responsibilities                                                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol adapter  | Preserve source positions, original roles, turn boundaries, tool type/name/original ID, arguments, and result parts. Protocol-specific media, custom input, and thinking conversion remain here |
| Shared normalizer | Analyze complete turns; classify groups as `paired / missing-result / orphaned-result / duplicate / conflict`; assign unique upstream IDs and produce preservation/conversion decisions         |
| Output generator  | Generate formal tool messages or ordinary context from the plan, retain surrounding content, and omit genuinely empty messages. Do not run a second independent deduplication policy            |

The shared layer retains **source references and occurrences** for calls and results rather than only `Set<id>`. A proposed interface is `normalizeToolHistory(events) -> { decisions, diagnostics }`, with `call/result/content/boundary` events and decisions referring to specific input positions. Input is immutable; there is no cross-request cache.

Diagnostics are per-request counts of retained pairs, missing results, orphaned results, removed duplicate calls/results, conflict groups, and remapped IDs. The adapter logs one summary from this result rather than aggregating mutable trackers. Model-visible provenance may retain bounded names/references from the supplied history; logs contain counts, not those values or result content.

Emit decisions only when `finalizeTurn()` closes a turn. This allows the normalizer to:

- Examine all parallel calls and conflicting results before deleting anything that could affect pairing.
- Preserve distinct occurrences of reused IDs instead of resetting a global seen bit.
- Generate messages in source order, grouping parallel formal parts as required by the upstream serializer within the same turn. ID remapping changes only formal call/result references, not result bodies.

Compare content structurally: object key order is irrelevant, array order is preserved, and media is compared using actual content or existing references. Do not use semantic similarity. If hashes are used as an index, confirm equal hashes with structural comparison; a hash match alone never authorizes deletion. Do not write content fingerprints to logs.

Validate invariants over the final emitted formal tool parts only: every formal result corresponds to exactly one earlier call in the request, and every formal call has exactly one result, with matching type and turn. Calls/results converted to ordinary context are excluded from this check. If the implementation violates an invariant, stop before sending upstream and report an internal normalization error. Do not hide it by deleting an arbitrary side.

### Integration Points

- Redesign the shared implementation and diagnostics interface in `src/server/utils/toolResultPairing.ts`.
- Integrate at the four array conversion entry points using the migration paths below. Preserve protocol representation conversion and boundaries between instruction arrays and history input.
- Remove superseded pairing/deduplication at each migrated entry point to avoid double processing. Single-message helpers must not decide that a result is missing; only entry points with the complete history make that decision.
- Server-generated web-search turns are checked only as completed snapshots when preparing the next upstream request. Do not run finalization over the live execution loop or newly generated calls awaiting results. Existing server-tool handling remains distinct from client function/custom-tool identities.
- Preserve the current public counting behavior of `/api/anthropic/v1/messages/count_tokens` and `/api/gemini/v1beta/models/{model}:countTokens`: both currently estimate the serialized request body. Changing these endpoint contracts or existing usage-estimation rules is outside v1. Fixture measurements of normalized input are separate from client-visible counts and provider-reported usage.
- Log only reason/count summaries, without adding raw arguments, results, or sensitive IDs. Track recoveries per request. HTTP 200 and CLI exit 0 are not sufficient success criteria.

| Entry point          | Baseline implementation at `f041fe1`                                   | Migration and regression focus                                                                       |
| -------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `anthropic.ts`       | Uses the shared tracker                                                | Replace tracker decisions; preserve mixed content and orphan-context conversion                      |
| `openaiResponses.ts` | Uses separate shared trackers for function/custom tools                | Replace tracker decisions; preserve tool types, parallel item grouping, and instruction boundaries   |
| `openaiChat.ts`      | Converts tool messages directly, without pairing checks                | Introduce normalization; verify valid chat histories remain unchanged                                |
| `gemini.ts`          | Uses an inline name-based FIFO queue and #251 turn-local deduplication | Replace both with shared decisions while preserving Gemini ID-less matching and resume compatibility |

Valid histories should retain their existing behavior. This work adds no dependencies and does not change response protocols.

## Validation and Delivery Boundaries

Start with shared pure-logic tests from the example table, then run equivalent semantic scenarios through all four entry points to verify roles, media, and tool-type conversion. Check idempotence, input immutability, generated-ID uniqueness, and the absence of dangling formal tool messages.

Additional cases must cover parallel results split across messages, ambiguous IDs within a turn, reused IDs across turns, mixed explicit/omitted IDs, conflicting result content including masking, empty/error results, large text or media in orphaned results, non-tool content ordering, and state isolation between requests.

Retain the original input of the real Gemini CLI resume failure fixture from #251. Review and update its expected normalized output under these rules: structurally equal objects remain equal despite key order, but genuinely different or masked/full result bodies become conflict context. Do not require byte-for-byte output parity with #251; require upstream acceptance, information preservation, and complete emitted pairs. Cover recovery requests for Anthropic and both OpenAI endpoints, server web-search turns, and official SDK behavior. Run type-checking, lint, and the full extension suite; live verification must inspect AM logs and response contents.

Integrate and validate one entry point at a time, then run cross-adapter regressions before release. Observe recovery counts, upstream transcript errors, and fixture input-size changes. Rollback uses the normal release/revert process; v1 does not add a runtime feature flag, parallel legacy normalizer, or automatic fallback that could conceal a broken invariant.

Implementation updates the README and includes a changeset. Lossy result compression, cross-turn inference of execution identity, tool execution/retry policies, and Live API support are outside the first version.
