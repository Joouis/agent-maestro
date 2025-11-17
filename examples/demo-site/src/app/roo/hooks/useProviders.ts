import { useCallback, useEffect, useState } from "react";

import { DEFAULT_API_BASE_URL } from "../utils/constants";

interface UseProvidersOptions {
  apiBaseUrl?: string | null;
  extensionId?: string;
}

interface ProvidersData {
  currentProvider?: string;
  currentModel?: string;
  providers: string[];
}

export const useProviders = (options: UseProvidersOptions = {}) => {
  const { apiBaseUrl = null, extensionId } = options;
  const [providersData, setProvidersData] = useState<ProvidersData>({
    providers: [],
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProviders = useCallback(async () => {
    // Don't fetch if no extension is selected yet
    if (!extensionId) {
      setIsLoading(false);
      setError("No extension selected");
      return;
    }

    setIsLoading(true);
    setError(null);

    const baseUrl = apiBaseUrl || DEFAULT_API_BASE_URL;

    // Construct providers URL
    const providersUrl = new URL(`${baseUrl}/api/v1/roo/providers`);
    providersUrl.searchParams.set("extensionId", extensionId);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(providersUrl.toString(), {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        setProvidersData({
          currentProvider: data.currentProvider,
          currentModel: data.currentModel,
          providers: data.providers || [],
        });
        setIsLoading(false);
        return;
      }

      throw new Error("Failed to fetch providers");
    } catch (err) {
      console.warn("Failed to fetch providers from API:", err);
      setError("Providers API unavailable");
      // Set empty providers list on error
      setProvidersData({ providers: [] });
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl, extensionId]);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  return {
    ...providersData,
    isLoading,
    error,
    refetch: fetchProviders,
  };
};
