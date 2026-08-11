export const SSE_HEARTBEAT_INTERVAL_MS = 10_000;
export const SSE_HEARTBEAT = Symbol("sse-heartbeat");

type NextOutcome<T> = {
  kind: "next";
  result: IteratorResult<T>;
};

type HeartbeatOutcome = {
  kind: "heartbeat";
};

export async function* withSseHeartbeat<T>(
  stream: AsyncIterable<T>,
  intervalMs: number = SSE_HEARTBEAT_INTERVAL_MS,
): AsyncGenerator<T | typeof SSE_HEARTBEAT> {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("SSE heartbeat interval must be greater than zero");
  }

  const iterator = stream[Symbol.asyncIterator]();
  let completed = false;
  let pendingNext: Promise<NextOutcome<T>> = iterator
    .next()
    .then((result) => ({ kind: "next", result }));

  try {
    while (true) {
      let timeout: NodeJS.Timeout | undefined;
      const heartbeat = new Promise<HeartbeatOutcome>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "heartbeat" }), intervalMs);
        timeout.unref();
      });

      let outcome: NextOutcome<T> | HeartbeatOutcome;
      try {
        outcome = await Promise.race([pendingNext, heartbeat]);
      } finally {
        clearTimeout(timeout);
      }

      if (outcome.kind === "heartbeat") {
        yield SSE_HEARTBEAT;
        continue;
      }

      if (outcome.result.done) {
        completed = true;
        return;
      }

      yield outcome.result.value;
      pendingNext = iterator
        .next()
        .then((result) => ({ kind: "next", result }));
    }
  } finally {
    if (!completed) {
      await iterator.return?.();
    }
  }
}
