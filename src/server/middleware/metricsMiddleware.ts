import type { Context, MiddlewareHandler } from "hono";

import { ApiEndpoint, metricsCollector } from "../metrics/MetricsCollector";

declare module "hono" {
  interface ContextVariableMap {
    metricsRequestId?: string;
    metricsStartedAt?: number;
    metricsEndpoint?: ApiEndpoint;
    metricsPath?: string;
    metricsMethod?: string;
    metricsDeferEnd?: boolean;
  }
}

function detectEndpoint(path: string): ApiEndpoint {
  if (path.startsWith("/api/anthropic")) {
    return "anthropic";
  }
  if (path.startsWith("/api/openai")) {
    return "openai";
  }
  if (path.startsWith("/api/gemini")) {
    return "gemini";
  }
  return "other";
}

export const metricsMiddleware: MiddlewareHandler = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const endpoint = detectEndpoint(path);
  const { id, startedAt } = metricsCollector.beginRequest();
  c.set("metricsRequestId", id);
  c.set("metricsStartedAt", startedAt);
  c.set("metricsEndpoint", endpoint);
  c.set("metricsPath", path);
  c.set("metricsMethod", c.req.method);

  let status = 0;
  let err: unknown;
  try {
    await next();
    status = c.res.status;
  } catch (e) {
    err = e;
    status = 500;
    throw e;
  } finally {
    if (c.get("metricsDeferEnd")) {
      return;
    }
    finishMetricsRequest(c, {
      status,
      streaming: (c.res?.headers.get("content-type") ?? "").includes(
        "event-stream",
      ),
      error: err ? String((err as Error).message ?? err) : undefined,
    });
  }
};

export function keepMetricsActiveUntilStreamEnd(c: Context) {
  c.set("metricsDeferEnd", true);
  c.req.raw.signal.addEventListener(
    "abort",
    () => {
      finishMetricsRequest(c, {
        status: 499,
        streaming: true,
        error: "client aborted request",
      });
    },
    { once: true },
  );
}

export function finishMetricsRequest(
  c: Context,
  info: {
    status?: number;
    streaming?: boolean;
    error?: string;
    inputTokens?: number;
    outputTokens?: number;
    ttftMs?: number;
    model?: string;
  } = {},
) {
  const id = c.get("metricsRequestId");
  const startedAt = c.get("metricsStartedAt");
  const endpoint = c.get("metricsEndpoint");
  const path = c.get("metricsPath");
  const method = c.get("metricsMethod");

  if (!id || !startedAt || !endpoint || !path || !method) {
    return;
  }

  metricsCollector.endRequest({
    id,
    endpoint,
    method,
    path,
    status: info.status ?? c.res.status,
    startedAt,
    durationMs: Date.now() - startedAt,
    streaming: info.streaming ?? false,
    inputTokens: info.inputTokens,
    outputTokens: info.outputTokens,
    ttftMs: info.ttftMs,
    model: info.model,
    error: info.error,
  });
}

export function recordMetricsTokens(
  c: Context,
  info: {
    inputTokens?: number;
    outputTokens?: number;
    ttftMs?: number;
    model?: string;
  },
) {
  const id = c.get("metricsRequestId");
  if (!id) {
    return;
  }
  metricsCollector.attachTokens(id, info);
}

export function getMetricsStartedAt(c: Context): number | undefined {
  return c.get("metricsStartedAt");
}
