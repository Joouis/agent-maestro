# Roo Extension API Notes

These notes distinguish Roo's in-process extension API from Agent Maestro's HTTP wrapper. They were checked against the installed `@roo-code/types` **1.86.0** declarations on 2026-09-05. Roo and compatible variants can expose different versions at runtime.

For a remote client, start with [AM Roo HTTP/SSE](../roo-routes-events.md) and the running `/openapi.json`. The extension API's positional event arguments are not AM's HTTP payload format.

| Topic                                     | Guide                                          |
| ----------------------------------------- | ---------------------------------------------- |
| Task and configuration API                | [API overview](roo-api-overview.md)            |
| In-process events                         | [Event notes](roo-api-events.md)               |
| Provider profiles                         | [Provider configuration](roo-api-providers.md) |
| Tools, message payloads, and MCP boundary | [Tool notes](roo-api-tools.md)                 |

## Source of Truth

Use the [versioned package declarations](https://unpkg.com/@roo-code/types@1.86.0/dist/index.d.ts) for exact signatures, provider names, and message unions. The project's [package manifest](../../package.json) records the dependency range; the lockfile records the installed version. These notes deliberately do not copy every upstream type.

AM's own VS Code/Node requirements are in the [root README](../../README.md#prerequisites). They are distinct from the runtime requirements of an installed Roo extension.
