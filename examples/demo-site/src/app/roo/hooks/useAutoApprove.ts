import { useCallback, useEffect, useState } from "react";

import { DEFAULT_API_BASE_URL } from "../utils/constants";

interface UseAutoApproveOptions {
  apiBaseUrl?: string | null;
  extensionId?: string;
}

interface AutoApproveSettings {
  autoApprovalEnabled: boolean;
  alwaysAllowReadOnly: boolean;
  alwaysAllowWrite: boolean;
  alwaysAllowExecute: boolean;
  alwaysAllowBrowser: boolean;
  alwaysAllowMcp: boolean;
  alwaysAllowModeSwitch: boolean;
  alwaysAllowSubtasks: boolean;
}

const defaultSettings: AutoApproveSettings = {
  autoApprovalEnabled: false,
  alwaysAllowReadOnly: false,
  alwaysAllowWrite: false,
  alwaysAllowExecute: false,
  alwaysAllowBrowser: false,
  alwaysAllowMcp: false,
  alwaysAllowModeSwitch: false,
  alwaysAllowSubtasks: false,
};

export const useAutoApprove = (options: UseAutoApproveOptions = {}) => {
  const { apiBaseUrl = null, extensionId } = options;
  const [settings, setSettings] =
    useState<AutoApproveSettings>(defaultSettings);
  const [isLoading, setIsLoading] = useState(true);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    if (!extensionId) {
      setIsLoading(false);
      setError("No extension selected");
      return;
    }

    setIsLoading(true);
    setError(null);

    const baseUrl = apiBaseUrl || DEFAULT_API_BASE_URL;
    const url = new URL(`${baseUrl}/api/v1/roo/auto-approve`);
    url.searchParams.set("extensionId", extensionId);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url.toString(), {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        setSettings(data);
        setIsLoading(false);
        return;
      }

      throw new Error("Failed to fetch auto-approve settings");
    } catch (err) {
      console.warn("Failed to fetch auto-approve settings:", err);
      setError("Auto-approve API unavailable");
      setSettings(defaultSettings);
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl, extensionId]);

  const updateSettings = useCallback(
    async (newSettings: Partial<AutoApproveSettings>) => {
      if (!extensionId) {
        setError("No extension selected");
        return false;
      }

      setIsUpdating(true);
      setError(null);

      const baseUrl = apiBaseUrl || DEFAULT_API_BASE_URL;
      const url = new URL(`${baseUrl}/api/v1/roo/auto-approve`);
      url.searchParams.set("extensionId", extensionId);

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(url.toString(), {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(newSettings),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();
          setSettings(data.settings);
          setIsUpdating(false);
          return true;
        }

        throw new Error("Failed to update auto-approve settings");
      } catch (err) {
        console.error("Failed to update auto-approve settings:", err);
        setError("Failed to update settings");
        return false;
      } finally {
        setIsUpdating(false);
      }
    },
    [apiBaseUrl, extensionId],
  );

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  return {
    settings,
    isLoading,
    isUpdating,
    error,
    updateSettings,
    refetch: fetchSettings,
  };
};
