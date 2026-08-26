# Codex Multi-Agent Responses E2E Runbook

Use this procedure when changing Responses tool conversion, namespace handling,
function-call streaming, or Codex collaboration compatibility. This is a manual
smoke test rather than a regular CI test because it requires an authenticated
Copilot session inside VS Code Insiders and consumes model quota.

## Prerequisites

- VS Code Insiders with GitHub Copilot signed in and the target model available.
- A Codex CLI version that supports Multi-Agent V2 plaintext collaboration
  messages (`encrypted_function_args: []`).
- Free local ports for an isolated Agent Maestro instance. The examples use
  `24333` and `24334` to avoid replacing a normal installation on the default
  ports.

## 1. Build and launch the extension

From the repository root:

```bash
pnpm build

AGENT_MAESTRO_PROXY_PORT=24333 \
AGENT_MAESTRO_MCP_PORT=24334 \
code-insiders \
  --new-window \
  --wait \
  --extensionDevelopmentPath="$PWD" \
  "$PWD"
```

Keep this process running. In another terminal, verify that the development
extension is serving requests and that the intended model is available:

```bash
curl -fsS http://127.0.0.1:24333/api/v1/lm/chatModels |
  jq '.[] | select(.id == "gpt-5.6-sol")'
```

## 2. Probe the Responses contract directly

Send a forced collaboration tool call:

```bash
curl -fsS http://127.0.0.1:24333/api/openai/v1/responses \
  -H 'content-type: application/json' \
  -d '{
    "model": "gpt-5.6-sol",
    "input": "Call spawn_agent with task_name canary, fork_turns none, and message exactly PLAINTEXT_CANARY.",
    "tools": [{
      "type": "namespace",
      "name": "collaboration",
      "description": "Sub-agent tools",
      "tools": [{
        "type": "function",
        "name": "spawn_agent",
        "description": "Spawn an agent",
        "parameters": {
          "type": "object",
          "properties": {
            "task_name": { "type": "string" },
            "fork_turns": { "type": "string" },
            "message": { "type": "string", "encrypted": true }
          },
          "required": ["task_name", "message"],
          "additionalProperties": false
        }
      }]
    }],
    "tool_choice": { "type": "function", "name": "spawn_agent" },
    "stream": false
  }' |
  jq '.output'
```

The function-call output must contain plaintext arguments and the explicit
Codex plaintext marker:

```json
{
  "type": "function_call",
  "name": "spawn_agent",
  "namespace": "collaboration",
  "arguments": "{\"task_name\":\"canary\",\"fork_turns\":\"none\",\"message\":\"PLAINTEXT_CANARY\"}",
  "encrypted_function_args": []
}
```

## 3. Run a real Codex V2 subagent

Do not use `--ephemeral`; the rollout files are needed for verification.

```bash
codex exec \
  --json \
  --enable multi_agent_v2 \
  -m gpt-5.6-sol \
  -c 'model_provider="agent-maestro"' \
  -c 'model_providers.agent-maestro.base_url="http://127.0.0.1:24333/api/openai/v1"' \
  -C "$PWD" \
  'Use spawn_agent exactly once with task_name plaintext_canary, fork_turns none, and message exactly: Reply exactly CHILD_PLAINTEXT_CANARY. Wait for that child to finish, then return its exact reply. Do not inspect or modify files.'
```

The command must finish with `CHILD_PLAINTEXT_CANARY`.

## 4. Inspect the parent and child rollouts

Locate the two new rollout files under the current date in
`~/.codex/sessions/YYYY/MM/DD/`. The parent rollout must contain:

```json
{
  "type": "function_call",
  "name": "spawn_agent",
  "namespace": "collaboration",
  "arguments": "{\"fork_turns\":\"none\",\"message\":\"Reply exactly CHILD_PLAINTEXT_CANARY.\",\"task_name\":\"plaintext_canary\"}",
  "encrypted_function_args": []
}
```

The child rollout must contain a readable task:

```json
{
  "type": "agent_message",
  "author": "/root",
  "recipient": "/root/plaintext_canary",
  "content": [
    {
      "type": "input_text",
      "text": "Message Type: NEW_TASK\nTask name: /root/plaintext_canary\nSender: /root\nPayload:\nReply exactly CHILD_PLAINTEXT_CANARY."
    }
  ]
}
```

The validation fails if the child task contains an `encrypted_content` part, if
the visible text stops after `Payload:`, or if the child reports that no task
details were provided.

## 5. Clean up

Close only the Insiders window created for this validation and confirm that the
isolated proxy port is no longer listening:

```bash
lsof -nP -iTCP:24333 -sTCP:LISTEN
```
