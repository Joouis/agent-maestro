---
"agent-maestro": patch
---

Fix Responses reasoning replay by rejecting hosts that discard or rewrite encrypted state and preserving pending tool pairs across intervening assistant output.

Validate and deduplicate reasoning before private hosted-search continuation, and preserve synthesis text/reasoning order with message-local citations and shared output budgeting in JSON and SSE.
