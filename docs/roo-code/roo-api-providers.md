# Roo Provider Configuration

Provider and model fields belong to the Roo extension. These notes were checked against [@roo-code/types 1.86.0](https://unpkg.com/@roo-code/types@1.86.0/dist/index.d.ts); they do not guarantee that every installed Roo variant supports the same providers.

## Supported Providers

Use `providerNames`, `providerSettingsSchema`, and `ProviderSettings` from the pinned dependency rather than a copied provider/model inventory. Provider lists change frequently. AM's HTTP validation is defined separately in [schemas/roo.ts](../../src/server/schemas/roo.ts); clients must also satisfy that schema.

Choose a model actually available through the configured provider. Example model IDs from old tutorials are not availability guarantees. Roo's provider configuration is separate from AM's Copilot-backed LLM proxy model selection.

## Profiles

The in-process API exposes named profile create/read/update/delete/activate methods; see the [API overview](roo-api-overview.md). AM exposes the corresponding `/api/v1/roo/profiles` routes listed in the [HTTP reference](../roo-routes-events.md#access-and-endpoints).

Profile entries identify a profile; they are not complete credentials. AM filters known secret settings from settings/profile responses. Do not log full provider configuration, store credentials in examples, or assume newly added upstream secret fields are automatically covered.

Inspect [rooSettingsFilter.ts](../../src/utils/rooSettingsFilter.ts) when adding provider support, and update its tests alongside the request schema. Secret storage within Roo itself is managed by the installed extension.

## Settings

`RooCodeSettings` combines global and provider fields. Common topics include model selection, context management, tool permissions, and request limits. Their effect depends on the chosen Roo provider and model; a field in the type definition is not a universal capability guarantee.

Use the Roo settings UI or a profile validated against the current schema. Keep automatic tool approval disabled unless the task and operation policy explicitly permit it.
