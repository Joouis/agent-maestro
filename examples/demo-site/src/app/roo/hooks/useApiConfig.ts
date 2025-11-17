import { useCallback, useEffect, useState } from "react";

import { storage } from "../utils/storage";

interface ApiConfig {
  baseUrl: string | null;
  isConnected: boolean;
  isChecking: boolean;
  error: string | null;
  lastConnected: string | null;
  workspace: string | null;
  agentMaestroVersion: string | null;
}

export const useApiConfig = () => {
  const [config, setConfig] = useState<ApiConfig>({
    baseUrl: null,
    isConnected: false,
    isChecking: false,
    error: null,
    lastConnected: null,
    workspace: null,
    agentMaestroVersion: null,
  });

  // Load saved URL on mount
  useEffect(() => {
    const savedUrl = storage.getApiBaseUrl();
    const lastConnected = storage.getLastConnected();
    if (savedUrl) {
      setConfig((prev) => ({
        ...prev,
        baseUrl: savedUrl,
        lastConnected,
      }));
    }
  }, []);

  const checkConnection = useCallback(
    async (
      url: string,
    ): Promise<{ ok: boolean; workspace?: string; version?: string }> => {
      try {
        // Remove trailing slash if present
        const cleanUrl = url.replace(/\/+$/, "");
        const infoUrl = `${cleanUrl}/api/v1/info`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(infoUrl, {
          method: "GET",
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();
          return {
            ok: true,
            workspace: data.workspace || null,
            version: data.version || null,
          };
        }
        return { ok: false };
      } catch (error) {
        console.error("Connection check failed:", error);
        return { ok: false };
      }
    },
    [],
  );

  const connect = useCallback(
    async (url: string): Promise<boolean> => {
      setConfig((prev) => ({ ...prev, isChecking: true, error: null }));

      const cleanUrl = url.replace(/\/+$/, "");
      const connectionResult = await checkConnection(cleanUrl);

      if (connectionResult.ok) {
        storage.setApiBaseUrl(cleanUrl);

        // Save workspace info for future selection
        if (connectionResult.workspace) {
          const workspaceParts = connectionResult.workspace.split("/");
          const workspaceName =
            workspaceParts[workspaceParts.length - 1] ||
            connectionResult.workspace;

          storage.saveWorkspace({
            url: cleanUrl,
            workspace: connectionResult.workspace,
            workspaceName,
            version: connectionResult.version || "unknown",
            lastConnected: new Date().toISOString(),
          });
        }

        setConfig({
          baseUrl: cleanUrl,
          isConnected: true,
          isChecking: false,
          error: null,
          lastConnected: new Date().toISOString(),
          workspace: connectionResult.workspace || null,
          agentMaestroVersion: connectionResult.version || null,
        });
        return true;
      } else {
        setConfig((prev) => ({
          ...prev,
          isChecking: false,
          error:
            "Unable to connect. Check URL and ensure Agent Maestro is running.",
        }));
        return false;
      }
    },
    [checkConnection],
  );

  const disconnect = useCallback(() => {
    storage.clearApiBaseUrl();
    setConfig({
      baseUrl: null,
      isConnected: false,
      isChecking: false,
      error: null,
      lastConnected: null,
      workspace: null,
      agentMaestroVersion: null,
    });
  }, []);

  const reconnect = useCallback(async (): Promise<boolean> => {
    if (!config.baseUrl) return false;
    return connect(config.baseUrl);
  }, [config.baseUrl, connect]);

  return {
    ...config,
    connect,
    disconnect,
    reconnect,
    checkConnection,
  };
};
