---
"agent-maestro": major
---

Protect control and LLM HTTP APIs with a shared, atomically stored key verifier. First use and upgrades require Set API Key to set/import a key or explicitly disable authentication; missing or invalid policy fails closed. Keep minimal health discovery public and share policy across windows, profiles, and installations for the same OS user.

Breaking migration: all existing installations must explicitly set/import an API key or disable authentication before HTTP clients can resume. Configure commands now verify the supplied key and write usable credentials for Claude Code, Claude Desktop, Codex, and Gemini CLI. Mixed-version windows recognize legacy instances and monitor the port for takeover, while warning that the older instance is not protected by the new policy.

Require confirmation before disabling HTTP authentication, provide actionable private-directory recovery guidance, and queue brief authentication bursts with bounded work and Retry-After overload responses.
