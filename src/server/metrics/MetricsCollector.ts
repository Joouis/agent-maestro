import { EventEmitter } from "events";

export type ApiEndpoint = "anthropic" | "openai" | "gemini" | "other";

export interface RequestDetails {
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

export interface RequestRecord {
  id: string;
  endpoint: ApiEndpoint;
  method: string;
  path: string;
  model?: string;
  status: number;
  startedAt: number;
  durationMs: number;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  tokensPerSecond?: number;
  streaming: boolean;
  error?: string;
  details?: RequestDetails;
}

export interface MetricsSnapshot {
  recent: RequestRecord[];
  totals: {
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
  };
  rolling: {
    windowMs: number;
    requests: number;
    errors: number;
    successRate: number;
    avgTtftMs: number;
    avgTokensPerSecond: number;
    p50DurationMs: number;
    p95DurationMs: number;
    p99DurationMs: number;
  };
  byEndpoint: Record<
    ApiEndpoint,
    {
      requests: number;
      errors: number;
      inputTokens: number;
      outputTokens: number;
    }
  >;
  byModel: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
    }
  >;
  statusCounts: Record<string, number>;
  activeRequests: number;
}

const DEFAULT_MAX_RECORDS = 500;
const ROLLING_WINDOW_MS = 5 * 60_000;

type TokenInfo = {
  inputTokens?: number;
  outputTokens?: number;
  ttftMs?: number;
  model?: string;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx];
}

function emptyEndpointAgg() {
  return { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
}

export class MetricsCollector extends EventEmitter {
  private buffer: RequestRecord[] = [];
  private maxRecords: number;
  private activeIds = new Set<string>();
  private totals = {
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  private byEndpoint: Record<ApiEndpoint, ReturnType<typeof emptyEndpointAgg>> =
    {
      anthropic: emptyEndpointAgg(),
      openai: emptyEndpointAgg(),
      gemini: emptyEndpointAgg(),
      other: emptyEndpointAgg(),
    };
  private byModel = new Map<
    string,
    { requests: number; inputTokens: number; outputTokens: number }
  >();
  private statusCounts = new Map<string, number>();
  private pendingTokenInfo = new Map<string, TokenInfo>();

  constructor(maxRecords: number = DEFAULT_MAX_RECORDS) {
    super();
    this.maxRecords = Math.max(50, maxRecords);
  }

  setMaxRecords(n: number) {
    this.maxRecords = Math.max(50, n);
    while (this.buffer.length > this.maxRecords) {
      this.buffer.shift();
    }
  }

  beginRequest(): { id: string; startedAt: number } {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    this.activeIds.add(id);
    this.emit("active", this.activeIds.size);
    return { id, startedAt: Date.now() };
  }

  endRequest(record: Omit<RequestRecord, "id"> & { id: string }) {
    if (!this.activeIds.delete(record.id)) {
      return;
    }
    this.emit("active", this.activeIds.size);

    const pendingInfo = this.pendingTokenInfo.get(record.id);
    if (pendingInfo) {
      record.inputTokens = pendingInfo.inputTokens ?? record.inputTokens;
      record.outputTokens = pendingInfo.outputTokens ?? record.outputTokens;
      record.ttftMs = pendingInfo.ttftMs ?? record.ttftMs;
      record.model = pendingInfo.model ?? record.model;
      this.pendingTokenInfo.delete(record.id);
    }

    if (
      record.tokensPerSecond === undefined &&
      record.outputTokens &&
      record.durationMs > 0
    ) {
      record.tokensPerSecond = +(
        (record.outputTokens / record.durationMs) *
        1000
      ).toFixed(2);
    }

    this.buffer.push(record);
    if (this.buffer.length > this.maxRecords) {
      this.buffer.shift();
    }

    this.totals.requests++;
    if (record.status >= 400) {
      this.totals.errors++;
    }
    if (record.inputTokens) {
      this.totals.inputTokens += record.inputTokens;
    }
    if (record.outputTokens) {
      this.totals.outputTokens += record.outputTokens;
    }

    const ep = this.byEndpoint[record.endpoint];
    ep.requests++;
    if (record.status >= 400) {
      ep.errors++;
    }
    if (record.inputTokens) {
      ep.inputTokens += record.inputTokens;
    }
    if (record.outputTokens) {
      ep.outputTokens += record.outputTokens;
    }

    if (record.model) {
      const m = this.byModel.get(record.model) ?? {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      m.requests++;
      if (record.inputTokens) {
        m.inputTokens += record.inputTokens;
      }
      if (record.outputTokens) {
        m.outputTokens += record.outputTokens;
      }
      this.byModel.set(record.model, m);
    }

    const sc = `${Math.floor(record.status / 100)}xx`;
    this.statusCounts.set(sc, (this.statusCounts.get(sc) ?? 0) + 1);

    this.emit("request", record);
  }

  /**
   * Attach token usage info to the most recent record matching the given id.
   * Routes call this once they know final token counts (e.g. after stream end).
   */
  attachTokens(id: string, info: TokenInfo) {
    const rec = this.buffer.find((r) => r.id === id);
    if (!rec) {
      this.pendingTokenInfo.set(id, info);
      return;
    }
    if (info.inputTokens !== undefined) {
      const delta = info.inputTokens - (rec.inputTokens ?? 0);
      rec.inputTokens = info.inputTokens;
      this.totals.inputTokens += delta;
      this.byEndpoint[rec.endpoint].inputTokens += delta;
      if (rec.model) {
        const m = this.byModel.get(rec.model);
        if (m) {
          m.inputTokens += delta;
        }
      }
    }
    if (info.outputTokens !== undefined) {
      const delta = info.outputTokens - (rec.outputTokens ?? 0);
      rec.outputTokens = info.outputTokens;
      this.totals.outputTokens += delta;
      this.byEndpoint[rec.endpoint].outputTokens += delta;
      if (rec.model) {
        const m = this.byModel.get(rec.model);
        if (m) {
          m.outputTokens += delta;
        }
      }
    }
    if (info.ttftMs !== undefined) {
      rec.ttftMs = info.ttftMs;
    }
    if (info.model && !rec.model) {
      rec.model = info.model;
      const m = this.byModel.get(info.model) ?? {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      m.requests++;
      m.inputTokens += rec.inputTokens ?? 0;
      m.outputTokens += rec.outputTokens ?? 0;
      this.byModel.set(info.model, m);
    }
    if (rec.outputTokens && rec.durationMs > 0) {
      rec.tokensPerSecond = +(
        (rec.outputTokens / rec.durationMs) *
        1000
      ).toFixed(2);
    }
    this.emit("update", rec);
  }

  snapshot(): MetricsSnapshot {
    const now = Date.now();
    const recentWindow = this.buffer.filter(
      (r) => now - (r.startedAt + r.durationMs) <= ROLLING_WINDOW_MS,
    );
    const durations = recentWindow
      .map((r) => r.durationMs)
      .sort((a, b) => a - b);
    const ttfts = recentWindow
      .map((r) => r.ttftMs)
      .filter((v): v is number => typeof v === "number");
    const tps = recentWindow
      .map((r) => r.tokensPerSecond)
      .filter((v): v is number => typeof v === "number" && v > 0);
    const errors = recentWindow.filter((r) => r.status >= 400).length;

    return {
      recent: this.buffer.slice(-100),
      totals: { ...this.totals },
      rolling: {
        windowMs: ROLLING_WINDOW_MS,
        requests: recentWindow.length,
        errors,
        successRate:
          recentWindow.length === 0 ? 1 : 1 - errors / recentWindow.length,
        avgTtftMs:
          ttfts.length === 0
            ? 0
            : +(ttfts.reduce((a, b) => a + b, 0) / ttfts.length).toFixed(1),
        avgTokensPerSecond:
          tps.length === 0
            ? 0
            : +(tps.reduce((a, b) => a + b, 0) / tps.length).toFixed(2),
        p50DurationMs: percentile(durations, 50),
        p95DurationMs: percentile(durations, 95),
        p99DurationMs: percentile(durations, 99),
      },
      byEndpoint: {
        anthropic: { ...this.byEndpoint.anthropic },
        openai: { ...this.byEndpoint.openai },
        gemini: { ...this.byEndpoint.gemini },
        other: { ...this.byEndpoint.other },
      },
      byModel: Object.fromEntries(this.byModel.entries()),
      statusCounts: Object.fromEntries(this.statusCounts.entries()),
      activeRequests: this.activeIds.size,
    };
  }

  reset() {
    this.buffer = [];
    this.activeIds.clear();
    this.totals = {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    this.byEndpoint = {
      anthropic: emptyEndpointAgg(),
      openai: emptyEndpointAgg(),
      gemini: emptyEndpointAgg(),
      other: emptyEndpointAgg(),
    };
    this.byModel.clear();
    this.statusCounts.clear();
    this.pendingTokenInfo.clear();
    this.emit("reset");
  }
}

export const metricsCollector = new MetricsCollector();
