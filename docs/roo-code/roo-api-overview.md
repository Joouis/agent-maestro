# Roo Extension API Overview

This is an orientation to the in-process `RooCodeAPI` checked against [types 1.86.0](https://unpkg.com/@roo-code/types@1.86.0/dist/index.d.ts). For HTTP clients use [AM's route contract](../roo-routes-events.md).

## API Groups

| Group                    | Exposed methods                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Task lifecycle           | `startNewTask`, `resumeTask`, `isTaskInHistory`, `getCurrentTaskStack`, `clearCurrentTask`, `cancelCurrentTask`                              |
| Current-task interaction | `sendMessage`, `pressPrimaryButton`, `pressSecondaryButton`                                                                                  |
| Configuration            | `isReady`, `getConfiguration`, `setConfiguration`                                                                                            |
| Profiles                 | `getProfiles`, `getProfileEntry`, `createProfile`, `updateProfile`, `upsertProfile`, `deleteProfile`, `getActiveProfile`, `setActiveProfile` |

`startNewTask` accepts optional configuration, text, images, and `newTab`, and resolves to a task ID. `sendMessage` and button methods act on the current task; they do not accept a target task ID. AM's adapter handles task selection/resumption for its HTTP routes.

Use the [AM adapter](../../src/core/RooCodeAdapter.ts) as the maintained example of extension discovery, readiness checks, event registration, and method invocation. Do not infer an exposed method from a tool name available to the model.

## Event Handling

Register listeners before initiating an operation when its events matter. Filter by the intended task, retain the listener until that task reaches the relevant state, and remove it on completion, cancellation, or timeout. An unfiltered `once` listener can be consumed by a different task's event. See [event notes](roo-api-events.md).

## Configuration and IPC

`RooCodeSettings` combines global and provider settings. The [profile guide](roo-api-providers.md) explains the AM-facing boundary; the upstream declarations define exact fields.

`RooCodeIpcServer` and IPC message types are upstream interfaces. AM clients do not need to construct raw socket messages to use the HTTP or MCP server. This repository does not supply a general-purpose Roo IPC client.
