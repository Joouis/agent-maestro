# Claude Code Context Window Handling

Agent Maestro bridges three different context-window models when Claude Code uses
VS Code language models through the Anthropic-compatible proxy:

- GitHub Copilot advertises each model's prompt budget through
  `LanguageModelChat.maxInputTokens`.
- VS Code/Copilot accepts provider-specific `configuration.contextSize` to choose
  the prompt/input budget used for the actual request.
- Claude Code has its own model and compaction logic, including special handling
  for 1M-context models.

The goal is to make all three use the same source of truth: the selected VS Code
model's advertised `maxInputTokens`.

## Source Of Truth

Use `maxInputTokens` from the selected VS Code language model as the prompt/input
budget. Do not infer the context window from model names except where Claude Code
requires a marker for its own client-side behavior.

The prompt budget is separate from the response budget:

- `configuration.contextSize` is the prompt/input budget. In Copilot debug
  output, this appears as `maxPromptTokens`.
- Anthropic/OpenAI/Gemini response limits remain controlled by request options such
  as `max_tokens`, `max_output_tokens`, or equivalent fields.

## Configurator Behavior

`Agent Maestro: Configure Claude Code Settings` writes Claude Code environment
variables using the selected model metadata.

For models whose `maxInputTokens` looks like a 1M tier, Agent Maestro appends
`[1m]` to `ANTHROPIC_MODEL` so Claude Code enables its extended-context path.
The current band is:

- greater than `800_000`
- less than `1_500_000`

This intentionally targets the current 1M tier. Future larger tiers should get a
separate rule instead of widening this band.

The configurator also writes:

- `CLAUDE_CODE_AUTO_COMPACT_WINDOW=<selected maxInputTokens>` when the selected
  model has a positive `maxInputTokens` value.
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=85` only when the user has not already set a
  value.

Users must rerun `Agent Maestro: Configure Claude Code Settings` for these env
vars to be written into an existing Claude Code settings file.

Fallback token estimates and `/v1/messages/count_tokens` responses report VS Code's
raw token count unscaled. Earlier compaction is driven by the two env vars above —
lower `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` for more headroom — rather than by inflating
the reported counts.

## Proxy Behavior

Before calling `LanguageModelChat.sendRequest`, Agent Maestro applies
`withCopilotContextSize` to all proxy routes. The helper only mutates request
options for Copilot-provided models; non-Copilot providers are left unchanged.
For Copilot models with a positive `maxInputTokens`, this adds:

```json
{
  "configuration": {
    "contextSize": "<selected maxInputTokens>"
  }
}
```

This avoids VS Code/Copilot falling back to a smaller default context size for a
model that advertises a larger prompt budget.

## Model Routing

Claude Code uses the `[1m]` marker and `context-1m` beta header as client-side
signals for its 1M context path. Agent Maestro does not translate those signals
into synthetic Copilot model IDs; it passes the requested model ID into normal
exact/fuzzy matching against Copilot's advertised model list.

This keeps routing aligned with Copilot's current model catalogue, where the real
model IDs and their `maxInputTokens` values are the source of truth. For example,
if Copilot advertises `claude-opus-4.8` as a 1M model, Claude Code requests should
continue to route to `claude-opus-4.8` instead of a fabricated internal variant.

## Known Limits

- The `[1m]` threshold is a 1M-tier heuristic based on currently advertised
  Copilot model windows.
- Claude Code's status-line percentage can differ from auto-compaction math when
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is set; this is expected Claude Code
  behavior.
- If Copilot changes the meaning of `maxInputTokens` or `configuration.contextSize`,
  update this design and the tests together.
