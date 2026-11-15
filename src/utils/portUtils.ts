import * as http from "http";
import * as net from "net";

import { logger } from "./logger";

/**
 * Check if a port is available for use
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.listen(port, () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.on("error", () => {
      resolve(false);
    });
  });
}

/**
 * Identifies an Agent Maestro instance on the port. `legacy` is a proxy that
 * predates `/health`, and with it the Admin API Key: its `/api/v1` routes stay
 * unauthenticated regardless of the keys configured in this window.
 */
export async function detectAgentMaestroService(
  port: number,
): Promise<"current" | "legacy" | undefined> {
  const health = await probe(port, "/health");
  if (isAgentMaestroInfo(health?.body)) {
    return "current";
  }
  // Proxies older than /health only answer the public /api/v1/info. Without
  // this fallback, a window still running an old version during an update
  // looks like an unrelated app, and this window never takes the port over.
  if (
    health?.status === 404 &&
    isAgentMaestroInfo((await probe(port, "/api/v1/info"))?.body)
  ) {
    return "legacy";
  }
  return undefined;
}

function isAgentMaestroInfo(body: string | undefined): boolean {
  try {
    return body !== undefined && JSON.parse(body).name === "Agent Maestro";
  } catch {
    return false;
  }
}

function probe(
  port: number,
  path: string,
): Promise<{ status?: number; body: string } | undefined> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://0.0.0.0:${port}${path}`,
      { timeout: 2000 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", () => resolve(undefined));
    req.on("timeout", () => {
      req.destroy();
      resolve(undefined);
    });
  });
}

/**
 * Find an available port starting from the given port
 */
export async function findAvailablePort(
  startPort: number,
  maxAttempts: number = 10,
): Promise<number | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    const available = await isPortAvailable(port);

    if (available) {
      return port;
    }

    logger.debug(`Port ${port} is not available, trying next port`);
  }

  return null;
}

/**
 * Analyze port usage and determine the best course of action
 */
export async function analyzePortUsage(port: number): Promise<{
  available: boolean;
  isOurServer: boolean;
  legacy: boolean;
  action: "use" | "skip" | "findAlternative";
  message: string;
}> {
  const available = await isPortAvailable(port);

  if (available) {
    return {
      available: true,
      isOurServer: false,
      legacy: false,
      action: "use",
      message: `Port ${port} is available`,
    };
  }

  const instance = await detectAgentMaestroService(port);

  if (instance) {
    return {
      available: false,
      isOurServer: true,
      legacy: instance === "legacy",
      action: "skip",
      message: `Port ${port} is already in use by another instance of our proxy server`,
    };
  }

  return {
    available: false,
    isOurServer: false,
    legacy: false,
    action: "findAlternative",
    message: `Port ${port} is in use by another application`,
  };
}
