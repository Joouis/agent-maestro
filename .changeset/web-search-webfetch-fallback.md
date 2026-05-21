---
"agent-maestro": patch
---

feat(anthropic): redirect dropped `web_search` server-side tool to a `WebFetch` fallback

When a client (e.g. Claude Code) sends Anthropic's `web_search` server-side tool definition, #167 began dropping it because the underlying VS Code Language Model API can't execute it. That stops the request from hanging or 400-ing, but it also leaves the model unable to search the web at all.

This change adds a tiny system-prompt nudge whenever a `web_search_*` tool is dropped: the model is told to fall back to the `WebFetch` tool with `https://html.duckduckgo.com/html/?q=<URL-encoded query>` and a prompt asking it to extract the most relevant result titles, URLs, and snippets. WebFetch is a standard client-side tool in Claude Code (and similar agents), so the user gets web-search-style behavior back with zero proxy-side dependencies, no API keys, and no extra setup. DuckDuckGo's HTML endpoint is used because Google's search page blocks/degrades non-browser HTTP fetches, leaving WebFetch with nothing useful to summarize.

Other dropped server-side tools (`bash`, `computer`, etc.) are unaffected.
