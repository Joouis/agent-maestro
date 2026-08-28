import { logger } from "../../utils/logger";

export type ToolResultPairing = "duplicate" | "invalid" | "orphaned" | "paired";

const SAMPLE_LIMIT = 5;
const MAX_LOGGED_ID_LENGTH = 80;

export class ToolResultPairingTracker {
  private readonly pendingCallIds = new Set<string>();
  private readonly seenResultIds = new Set<string>();
  private readonly duplicateResultIds: string[] = [];
  private readonly invalidCallIds: unknown[] = [];
  private readonly invalidResultIds: unknown[] = [];
  private readonly orphanedResultIds: string[] = [];
  private duplicateResultCount = 0;
  private invalidCallIdCount = 0;
  private invalidResultIdCount = 0;
  private orphanedResultCount = 0;

  recordCall(callId: unknown): boolean {
    if (!isValidToolCallId(callId)) {
      this.invalidCallIdCount++;
      this.recordSample(this.invalidCallIds, callId);
      return false;
    }

    this.pendingCallIds.add(callId);
    return true;
  }

  recordResult(callId: unknown): ToolResultPairing {
    if (!isValidToolCallId(callId)) {
      this.invalidResultIdCount++;
      this.recordSample(this.invalidResultIds, callId);
      return "invalid";
    }

    if (this.seenResultIds.has(callId)) {
      this.duplicateResultCount++;
      this.recordSample(this.duplicateResultIds, callId);
      return "duplicate";
    }

    this.seenResultIds.add(callId);
    if (this.pendingCallIds.delete(callId)) {
      return "paired";
    }

    this.orphanedResultCount++;
    this.recordSample(this.orphanedResultIds, callId);
    return "orphaned";
  }

  get duplicateCount(): number {
    return this.duplicateResultCount;
  }

  get duplicateSamples(): readonly string[] {
    return this.duplicateResultIds;
  }

  get invalidCallCount(): number {
    return this.invalidCallIdCount;
  }

  get invalidCallSamples(): readonly unknown[] {
    return this.invalidCallIds;
  }

  get invalidResultCount(): number {
    return this.invalidResultIdCount;
  }

  get invalidResultSamples(): readonly unknown[] {
    return this.invalidResultIds;
  }

  get orphanedCount(): number {
    return this.orphanedResultCount;
  }

  get orphanedSamples(): readonly string[] {
    return this.orphanedResultIds;
  }

  private recordSample(samples: unknown[], callId: unknown): void {
    if (samples.length < SAMPLE_LIMIT) {
      samples.push(callId);
    }
  }
}

export function logToolResultRecovery(
  adapter: string,
  trackers: readonly ToolResultPairingTracker[],
): void {
  const orphanedCount = trackers.reduce(
    (total, tracker) => total + tracker.orphanedCount,
    0,
  );
  const duplicateCount = trackers.reduce(
    (total, tracker) => total + tracker.duplicateCount,
    0,
  );
  const invalidCallCount = trackers.reduce(
    (total, tracker) => total + tracker.invalidCallCount,
    0,
  );
  const invalidResultCount = trackers.reduce(
    (total, tracker) => total + tracker.invalidResultCount,
    0,
  );
  if (
    orphanedCount === 0 &&
    duplicateCount === 0 &&
    invalidCallCount === 0 &&
    invalidResultCount === 0
  ) {
    return;
  }

  const orphanedSamples = trackers
    .flatMap((tracker) => tracker.orphanedSamples)
    .slice(0, SAMPLE_LIMIT);
  const duplicateSamples = trackers
    .flatMap((tracker) => tracker.duplicateSamples)
    .slice(0, SAMPLE_LIMIT);
  const invalidSamples = trackers
    .flatMap((tracker) => [
      ...tracker.invalidCallSamples,
      ...tracker.invalidResultSamples,
    ])
    .slice(0, SAMPLE_LIMIT);

  logger.warn(
    `${adapter} tool result recovery: converted ${orphanedCount} orphaned result(s) to ordinary content${formatSamples(orphanedSamples)}; converted ${invalidCallCount} call(s) and ${invalidResultCount} result(s) with invalid IDs to ordinary content${formatSamples(invalidSamples)}; dropped ${duplicateCount} duplicate result(s)${formatSamples(duplicateSamples)}`,
  );
}

function isValidToolCallId(callId: unknown): callId is string {
  return typeof callId === "string" && callId.length > 0;
}

function formatSamples(callIds: readonly unknown[]): string {
  if (callIds.length === 0) {
    return "";
  }

  const samples = callIds.map((callId) => {
    const value = JSON.stringify(callId) ?? String(callId);
    const truncated =
      value.length > MAX_LOGGED_ID_LENGTH
        ? `${value.slice(0, MAX_LOGGED_ID_LENGTH)}...`
        : value;
    return truncated;
  });
  return ` (sample call IDs: ${samples.join(", ")})`;
}
