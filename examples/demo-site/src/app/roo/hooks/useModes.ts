import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_API_BASE_URL,
  MODES,
  createApiEndpoints,
} from "../utils/constants";

interface Mode {
  slug: string;
  name: string;
  roleDefinition?: string;
  customInstructions?: string;
  groups?: any[];
  source?: "builtin" | "custom";
  whenToUse?: string;
}

interface UseModesOptions {
  apiBaseUrl?: string | null;
  extensionId?: string;
}

export const useModes = (options: UseModesOptions = {}) => {
  const { apiBaseUrl = null, extensionId } = options;
  const [modes, setModes] = useState<Mode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchModes = useCallback(async () => {
    // Don't fetch if no extension is selected yet
    if (!extensionId) {
      setIsLoading(false);
      setError("No extension selected");
      // Return default modes while waiting for extension selection
      const fallbackModes: Mode[] = MODES.map((mode) => ({
        slug: mode.slug,
        name: mode.name,
        whenToUse: mode.whenToUse,
        groups: mode.groups as any[],
        source: "builtin" as const,
      }));
      setModes(fallbackModes);
      return;
    }

    setIsLoading(true);
    setError(null);

    const baseUrl = apiBaseUrl || DEFAULT_API_BASE_URL;

    // Construct modes URL
    const modesUrl = new URL(`${baseUrl}/api/v1/roo/modes`);
    modesUrl.searchParams.set("extensionId", extensionId);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(modesUrl.toString(), {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        if (data.modes && Array.isArray(data.modes)) {
          // Merge with local mode data for additional fields like whenToUse
          const mergedModes = data.modes.map((apiMode: Mode) => {
            const localMode = MODES.find((m) => m.slug === apiMode.slug);
            return {
              ...apiMode,
              whenToUse: localMode?.whenToUse || apiMode.roleDefinition || "",
              groups: apiMode.groups || localMode?.groups || [],
            };
          });
          setModes(mergedModes);
          setIsLoading(false);
          return;
        }
      }

      // Fallback to hardcoded modes if API fails or returns invalid data
      throw new Error("Invalid API response");
    } catch (err) {
      console.warn("Failed to fetch modes from API, using defaults:", err);
      // Fallback to hardcoded modes
      const fallbackModes: Mode[] = MODES.map((mode) => ({
        slug: mode.slug,
        name: mode.name,
        whenToUse: mode.whenToUse,
        groups: mode.groups as any[],
        source: "builtin" as const,
      }));
      setModes(fallbackModes);
      setError("Using default modes (API unavailable)");
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl, extensionId]);

  useEffect(() => {
    fetchModes();
  }, [fetchModes]);

  return {
    modes,
    isLoading,
    error,
    refetch: fetchModes,
  };
};
