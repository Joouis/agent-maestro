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
 * Check if the port is being used by our Agent Maestro service
 */
export function isAgentMaestroService(
  port: number,
  serviceType: "proxy" | "mcp" = "proxy",
): Promise<boolean> {
  return new Promise((resolve) => {
    const endpoint = serviceType === "proxy" ? "/api/v1/info" : "/health";

    const req = http.get(
      `http://0.0.0.0:${port}${endpoint}`,
      {
        timeout: 2000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          if (serviceType === "proxy") {
            try {
              const parsed = JSON.parse(data);
              const isOurs = parsed.name === "Agent Maestro";
              resolve(isOurs);
            } catch {
              resolve(false);
            }
          } else {
            const isOurs =
              data.trim() === "Agent Maestro MCP Server is running";
            resolve(isOurs);
          }
        });
      },
    );

    req.on("error", () => {
      resolve(false);
    });

    req.on("timeout", () => {
      req.destroy();
      resolve(false);
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
export async function analyzePortUsage(
  port: number,
  serviceType: "proxy" | "mcp" = "proxy",
): Promise<{
  available: boolean;
  isOurServer: boolean;
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

  const isOurs = await isAgentMaestroService(port, serviceType);

  if (isOurs) {
    return {
      available: false,
      isOurServer: true,
      action: "skip",
      message: `Port ${port} is already in use by another instance of our proxy server`,
    };
  }

  return {
    available: false,
    isOurServer: false,
    action: "findAlternative",
    message: `Port ${port} is in use by another application`,
  };
}
