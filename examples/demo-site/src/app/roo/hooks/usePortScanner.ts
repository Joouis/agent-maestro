import { useCallback, useState } from "react";

interface DiscoveredInstance {
  url: string;
  port: number;
  workspace: string;
  workspaceName: string;
  version: string;
}

interface UsePortScannerResult {
  instances: DiscoveredInstance[];
  isScanning: boolean;
  scanPorts: () => Promise<void>;
  error: string | null;
}

// Common ports to scan for Agent Maestro instances
const PORTS_TO_SCAN = [
  23333, // Default Agent Maestro port
  33333, // Common alternative
  43333,
  53333,
  8080,
  8081,
  3333,
  4444,
  5555,
];

export const usePortScanner = (): UsePortScannerResult => {
  const [instances, setInstances] = useState<DiscoveredInstance[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkPort = useCallback(
    async (port: number): Promise<DiscoveredInstance | null> => {
      try {
        const url = `http://localhost:${port}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(`${url}/api/v1/info`, {
          method: "GET",
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();
          if (data.workspace) {
            const workspaceParts = data.workspace.split("/");
            const workspaceName =
              workspaceParts[workspaceParts.length - 1] || data.workspace;

            return {
              url,
              port,
              workspace: data.workspace,
              workspaceName,
              version: data.version || "unknown",
            };
          }
        }
        return null;
      } catch {
        // Port not available or not Agent Maestro
        return null;
      }
    },
    [],
  );

  const scanPorts = useCallback(async () => {
    setIsScanning(true);
    setError(null);
    setInstances([]);

    try {
      const results = await Promise.all(PORTS_TO_SCAN.map(checkPort));
      const found = results.filter(
        (result): result is DiscoveredInstance => result !== null,
      );

      if (found.length === 0) {
        setError("No Agent Maestro instances found on localhost");
      }

      setInstances(found);
    } catch (err) {
      setError("Failed to scan ports");
      console.error("Port scan error:", err);
    } finally {
      setIsScanning(false);
    }
  }, [checkPort]);

  return {
    instances,
    isScanning,
    scanPorts,
    error,
  };
};
