import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";

import { logger } from "../../utils/logger";

export type ToolHistoryContent =
  | vscode.LanguageModelTextPart
  | vscode.LanguageModelDataPart;
export type ToolHistoryPart =
  | { kind: "content"; parts: ToolHistoryContent[] }
  | {
      kind: "call";
      id?: unknown;
      name: string;
      toolType: string;
      input: object;
      value: unknown;
      allowMissingId?: boolean;
    }
  | {
      kind: "result";
      id?: unknown;
      name?: string;
      toolType?: string;
      parts: ToolHistoryContent[];
      value: unknown;
      allowMissingId?: boolean;
      isError?: boolean;
    };

export interface ToolHistoryMessage {
  role: "assistant" | "user";
  parts: ToolHistoryPart[];
  /** Instructions and independent request sections cannot share a call turn. */
  boundary?: boolean;
}

export interface ToolHistoryDiagnostics {
  retainedPairs: number;
  missingResults: number;
  orphanedResults: number;
  duplicateCalls: number;
  duplicateResults: number;
  conflictGroups: number;
  remappedIds: number;
}

type Call = Extract<ToolHistoryPart, { kind: "call" }>;
type Result = Extract<ToolHistoryPart, { kind: "result" }>;
type Occurrence<T extends ToolHistoryPart = ToolHistoryPart> = {
  index: number;
  part: T;
};
type Group = {
  calls: Occurrence<Call>[];
  results: Occurrence<Result>[];
  conflict: boolean;
};
type Decision =
  | { kind: "call"; id: string; turn: number; call: Call }
  | {
      kind: "result";
      id: string;
      turn: number;
      toolType: string;
      result: Result;
    }
  | { kind: "context"; parts: ToolHistoryContent[] }
  | { kind: "drop" };

const validId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0;
const bounded = (value: unknown): string =>
  JSON.stringify(value)?.slice(0, 100) ?? "unknown";
const sameResult = (a: Result, b: Result): boolean =>
  a.name === b.name &&
  a.toolType === b.toolType &&
  isDeepStrictEqual(a.value, b.value);

/** Analyze a complete request snapshot; no decisions depend on another request. */
export function normalizeToolHistory(messages: readonly ToolHistoryMessage[]): {
  decisions: Map<number, Decision>;
  diagnostics: ToolHistoryDiagnostics;
} {
  const decisions = new Map<number, Decision>();
  const diagnostics: ToolHistoryDiagnostics = {
    retainedPairs: 0,
    missingResults: 0,
    orphanedResults: 0,
    duplicateCalls: 0,
    duplicateResults: 0,
    conflictGroups: 0,
    remappedIds: 0,
  };
  const reservedIds = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind !== "content" && validId(part.id)) {
        reservedIds.add(part.id);
      }
    }
  }
  const usedIds = new Set<string>();
  let turn = 0;
  let calls: Occurrence<Call>[] = [];
  let results: Occurrence<Result>[] = [];
  let phase: "calls" | "results" | undefined;

  const resultContext = (entry: Occurrence<Result>, conflict = false) => {
    const { part } = entry;
    decisions.set(entry.index, {
      kind: "context",
      parts: [
        new vscode.LanguageModelTextPart(
          conflict
            ? "[Conflicting tool history: result for " +
              bounded(part.name) +
              " (call " +
              bounded(part.id) +
              "); pairing is uncertain.]"
            : "[Tool result without a matching tool call: " +
              bounded(part.id) +
              "; tool " +
              bounded(part.name) +
              "]",
        ),
        ...(part.isError
          ? [new vscode.LanguageModelTextPart("[Tool reported an error]")]
          : []),
        ...part.parts,
      ],
    });
  };

  const finalizeTurn = () => {
    if (!calls.length && !results.length) {
      phase = undefined;
      return;
    }
    const groups: Group[] = [];
    for (const entry of calls) {
      const call = entry.part;
      let group = validId(call.id)
        ? groups.find(
            (g) =>
              g.calls[0].part.id === call.id &&
              g.calls[0].part.toolType === call.toolType,
          )
        : undefined;
      if (!group) {
        group = {
          calls: [],
          results: [],
          conflict:
            !call.name ||
            (!validId(call.id) &&
              !(call.id === undefined && call.allowMissingId)),
        };
        groups.push(group);
      } else if (
        group.calls[0].part.name !== call.name ||
        !isDeepStrictEqual(group.calls[0].part.value, call.value)
      ) {
        group.conflict = true;
      }
      group.calls.push(entry);
    }

    const orphans: Occurrence<Result>[] = [];
    // Explicit results reserve their calls before positional results consume FIFO slots.
    for (const entry of results.filter((r) => r.part.id !== undefined)) {
      const result = entry.part;
      const matches = validId(result.id)
        ? groups.filter(
            (g) =>
              g.calls[0].part.id === result.id &&
              (result.toolType === undefined ||
                g.calls[0].part.toolType === result.toolType),
          )
        : [];
      if (!matches.length) {
        orphans.push(entry);
        continue;
      }
      if (matches.length > 1) {
        matches.forEach((g) => {
          g.conflict = true;
        });
      }
      const group = matches[0];
      if (
        result.name !== undefined &&
        result.name !== group.calls[0].part.name
      ) {
        group.conflict = true;
      }
      group.results.push(entry);
    }
    for (const entry of results.filter((r) => r.part.id === undefined)) {
      const group =
        entry.part.allowMissingId && entry.part.name
          ? groups.find(
              (g) =>
                !g.conflict &&
                !g.results.length &&
                g.calls[0].part.name === entry.part.name &&
                (entry.part.toolType === undefined ||
                  g.calls[0].part.toolType === entry.part.toolType),
            )
          : undefined;
      if (group) {
        group.results.push(entry);
      } else {
        orphans.push(entry);
      }
    }

    const missing: Occurrence<Call>[] = [];
    for (const [groupIndex, group] of groups.entries()) {
      group.results.sort((a, b) => a.index - b.index);
      const firstCall = group.calls[0];
      const firstResult = group.results[0];
      if (
        firstResult &&
        group.results.some(
          (r) => !isDeepStrictEqual(r.part.value, firstResult.part.value),
        )
      ) {
        group.conflict = true;
      }
      group.calls.forEach((c) => decisions.set(c.index, { kind: "drop" }));
      if (group.conflict) {
        diagnostics.conflictGroups++;
        for (const entry of group.calls) {
          decisions.set(entry.index, {
            kind: "context",
            parts: [
              new vscode.LanguageModelTextPart(
                "[Conflicting tool history: " +
                  bounded(entry.part.name) +
                  " (" +
                  bounded(entry.part.toolType) +
                  ", call " +
                  bounded(entry.part.id) +
                  "); pairing is uncertain. Arguments omitted.]",
              ),
            ],
          });
        }
        group.results.forEach((r) => resultContext(r, true));
        continue;
      }
      diagnostics.duplicateCalls += group.calls.length - 1;
      if (!firstResult) {
        missing.push(firstCall);
        diagnostics.missingResults++;
        continue;
      }
      let upstreamId = validId(firstCall.part.id) ? firstCall.part.id : "";
      if (!upstreamId || usedIds.has(upstreamId)) {
        const prefix = "am_history_" + turn + "_" + groupIndex;
        upstreamId = prefix;
        let suffix = 0;
        while (reservedIds.has(upstreamId) || usedIds.has(upstreamId)) {
          upstreamId = prefix + "_" + ++suffix;
        }
        diagnostics.remappedIds++;
      }
      usedIds.add(upstreamId);
      decisions.set(firstCall.index, {
        kind: "call",
        id: upstreamId,
        turn,
        call: firstCall.part,
      });
      decisions.set(firstResult.index, {
        kind: "result",
        id: upstreamId,
        turn,
        toolType: firstCall.part.toolType,
        result: firstResult.part,
      });
      group.results
        .slice(1)
        .forEach((r) => decisions.set(r.index, { kind: "drop" }));
      diagnostics.duplicateResults += group.results.length - 1;
      diagnostics.retainedPairs++;
    }
    if (missing.length) {
      const names = new Map<string, number>();
      for (const c of missing) {
        names.set(c.part.name, (names.get(c.part.name) ?? 0) + 1);
      }
      const label = [...names]
        .slice(0, 5)
        .map(([name, count]) => bounded(name) + " (" + count + ")")
        .join(", ");
      decisions.set(missing[0].index, {
        kind: "context",
        parts: [
          new vscode.LanguageModelTextPart(
            "[Incomplete tool history: " +
              missing.length +
              " call(s) have no recorded result: " +
              label +
              (names.size > 5 ? ", ..." : "") +
              ". Execution status is unknown; verify before retrying.]",
          ),
        ],
      });
    }
    const keptOrphans: Result[] = [];
    for (const entry of orphans.sort((a, b) => a.index - b.index)) {
      if (
        validId(entry.part.id) &&
        keptOrphans.some(
          (r) => r.id === entry.part.id && sameResult(r, entry.part),
        )
      ) {
        decisions.set(entry.index, { kind: "drop" });
        diagnostics.duplicateResults++;
      } else {
        resultContext(entry);
        keptOrphans.push(entry.part);
        diagnostics.orphanedResults++;
      }
    }
    calls = [];
    results = [];
    phase = undefined;
    turn++;
  };

  let index = 0;
  for (const message of messages) {
    const hasCalls =
      message.role === "assistant" &&
      message.parts.some((p) => p.kind === "call");
    const hasResults =
      message.role === "user" && message.parts.some((p) => p.kind === "result");
    if (
      message.boundary ||
      (!hasCalls && !hasResults) ||
      (hasCalls && phase === "results")
    ) {
      finalizeTurn();
    }
    if (hasCalls) {
      phase = "calls";
    }
    if (hasResults) {
      phase = "results";
    }
    for (const part of message.parts) {
      if (part.kind === "call") {
        calls.push({ index, part });
      } else if (part.kind === "result") {
        results.push({ index, part });
      }
      index++;
    }
    if (message.boundary) {
      finalizeTurn();
    }
  }
  finalizeTurn();

  const pending = new Map<string, { turn: number; toolType: string }>();
  const emittedIds = new Set<string>();
  for (let i = 0; i < index; i++) {
    const decision = decisions.get(i);
    if (decision?.kind === "call") {
      if (emittedIds.has(decision.id)) {
        throw new Error("Duplicate normalized tool call ID");
      }
      emittedIds.add(decision.id);
      pending.set(decision.id, {
        turn: decision.turn,
        toolType: decision.call.toolType,
      });
    } else if (decision?.kind === "result") {
      const call = pending.get(decision.id);
      if (call?.turn !== decision.turn || call.toolType !== decision.toolType) {
        throw new Error("Unpaired normalized tool result");
      }
      pending.delete(decision.id);
    }
  }
  if (pending.size) {
    throw new Error("Unpaired normalized tool call");
  }
  return { decisions, diagnostics };
}

/** Render a plan for the upstream request without rewriting the source history. */
export function toolHistoryToVSCode(
  messages: readonly ToolHistoryMessage[],
  adapter: string,
): vscode.LanguageModelChatMessage[] {
  const { decisions, diagnostics } = normalizeToolHistory(messages);
  const output: vscode.LanguageModelChatMessage[] = [];
  let index = 0;
  let previousHadResults = false;
  let previousHadCalls = false;
  for (const message of messages) {
    const hasCalls =
      message.role === "assistant" &&
      message.parts.some((part) => part.kind === "call");
    const hasResults =
      message.role === "user" &&
      message.parts.some((part) => part.kind === "result");
    const parts: Array<
      | ToolHistoryContent
      | vscode.LanguageModelToolCallPart
      | vscode.LanguageModelToolResultPart
    > = [];
    for (const part of message.parts) {
      const decision = decisions.get(index++);
      if (part.kind === "content") {
        parts.push(...part.parts);
      } else if (decision?.kind === "context") {
        parts.push(...decision.parts);
      } else if (decision?.kind === "call") {
        parts.push(
          new vscode.LanguageModelToolCallPart(
            decision.id,
            decision.call.name,
            decision.call.input,
          ),
        );
      } else if (decision?.kind === "result") {
        parts.push(
          new vscode.LanguageModelToolResultPart(
            decision.id,
            decision.result.parts,
          ),
        );
      }
    }
    if (parts.length) {
      // Keep a result turn together when an orphan/conflict becomes text.
      // Otherwise that text-only message can split a surviving call/result pair.
      if (
        ((hasResults && previousHadResults) ||
          (hasCalls && previousHadCalls)) &&
        !message.boundary
      ) {
        output.at(-1)!.content.push(...parts);
      } else {
        output.push(
          message.role === "assistant"
            ? vscode.LanguageModelChatMessage.Assistant(
                parts as Array<
                  ToolHistoryContent | vscode.LanguageModelToolCallPart
                >,
              )
            : vscode.LanguageModelChatMessage.User(
                parts as Array<
                  ToolHistoryContent | vscode.LanguageModelToolResultPart
                >,
              ),
        );
      }
    }
    previousHadResults = hasResults && !message.boundary;
    previousHadCalls = hasCalls && !message.boundary;
  }
  const { retainedPairs: _pairs, ...recoveries } = diagnostics;
  // Copilot rejects ordinary content interleaved between parallel tool results.
  // Keep formal parts contiguous within each role message, preserving both orders.
  for (const message of output) {
    const tools = message.content.filter(
      (part) =>
        part instanceof vscode.LanguageModelToolCallPart ||
        part instanceof vscode.LanguageModelToolResultPart,
    );
    if (tools.length > 1) {
      const context = message.content.filter(
        (part) =>
          !(part instanceof vscode.LanguageModelToolCallPart) &&
          !(part instanceof vscode.LanguageModelToolResultPart),
      );
      message.content.splice(0, message.content.length, ...tools, ...context);
    }
  }
  if (Object.values(recoveries).some((count) => count > 0)) {
    logger.warn(
      adapter + " tool history normalization: " + JSON.stringify(diagnostics),
    );
  }
  return output;
}
