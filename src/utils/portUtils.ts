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

type DetectedService = "proxy" | "legacy-proxy" | "mcp";

function probeService(
  port: number,
  endpoint: string,
): Promise<{ status: number; body: string } | undefined> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const finish = (value?: { status: number; body: string }) => {
      clearTimeout(timer);
      resolve(value);
    };
    const req = http.get(`http://127.0.0.1:${port}${endpoint}`, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65536) {
          req.destroy();
          finish();
        }
      });
      res.on("end", () => finish({ status: res.statusCode ?? 0, body }));
      res.on("error", () => finish());
    });
    req.on("error", () => finish());
    timer = setTimeout(() => {
      req.destroy();
      finish();
    }, 2000);
  });
}

async function detectService(
  port: number,
  serviceType: "proxy" | "mcp",
): Promise<DetectedService | undefined> {
  const health = await probeService(port, "/health");
  if (serviceType === "mcp") {
    return health?.status === 200 &&
      health.body.trim() === "Agent Maestro MCP Server is running"
      ? "mcp"
      : undefined;
  }
  if (health?.status === 404) {
    // Upgrade compatibility: only older versions expose discovery through /info.
    const legacy = await probeService(port, "/api/v1/info");
    if (legacy?.status === 200) {
      try {
        if (JSON.parse(legacy.body)?.name === "Agent Maestro") {
          return "legacy-proxy";
        }
      } catch {}
    }
    return undefined;
  }
  if (health?.status === 200) {
    try {
      const value = JSON.parse(health.body);
      if (value?.name === "Agent Maestro" && value.status === "ok") {
        return "proxy";
      }
    } catch {}
  }
  return undefined;
}

/** Check for current or legacy Agent Maestro listeners without sending credentials. */
export async function isAgentMaestroService(
  port: number,
  serviceType: "proxy" | "mcp" = "proxy",
): Promise<boolean> {
  return (await detectService(port, serviceType)) !== undefined;
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
export async function analyzePortUsage(
  port: number,
  serviceType: "proxy" | "mcp" = "proxy",
): Promise<{
  available: boolean;
  isOurServer: boolean;
  legacy?: boolean;
  action: "use" | "skip" | "findAlternative";
  message: string;
}> {
  const available = await isPortAvailable(port);

  if (available) {
    return {
      available: true,
      isOurServer: false,
      action: "use",
      message: `Port ${port} is available`,
    };
  }

  const detected = await detectService(port, serviceType);

  if (detected) {
    return {
      available: false,
      isOurServer: true,
      legacy: detected === "legacy-proxy",
      action: "skip",
      message:
        detected === "legacy-proxy"
          ? `Port ${port} is owned by an older Agent Maestro instance. It does not apply the new HTTP authentication policy. Update or close that window; this window will monitor the port and start when it becomes free`
          : `Port ${port} is already in use by another instance of our proxy server`,
    };
  }

  return {
    available: false,
    isOurServer: false,
    action: "findAlternative",
    message: `Port ${port} is in use by another application`,
  };
}
