import { useCallback, useEffect, useState } from "react";

import { DEFAULT_API_BASE_URL } from "../utils/constants";

interface UseProfilesOptions {
  apiBaseUrl?: string | null;
  extensionId?: string;
}

interface Profile {
  id: string;
  name: string;
  apiProvider?: string;
  isActive: boolean;
}

interface ProfilesData {
  profiles: Profile[];
  activeProfile?: Profile;
}

export const useProfiles = (options: UseProfilesOptions = {}) => {
  const { apiBaseUrl = null, extensionId } = options;
  const [profilesData, setProfilesData] = useState<ProfilesData>({
    profiles: [],
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProfiles = useCallback(async () => {
    // Don't fetch if no extension is selected yet
    if (!extensionId) {
      setIsLoading(false);
      setError("No extension selected");
      return;
    }

    setIsLoading(true);
    setError(null);

    const baseUrl = apiBaseUrl || DEFAULT_API_BASE_URL;

    // Construct profiles URL
    const profilesUrl = new URL(`${baseUrl}/api/v1/roo/profiles`);
    profilesUrl.searchParams.set("extensionId", extensionId);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(profilesUrl.toString(), {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();

        // Transform profiles to include isActive flag
        const profiles = (data.profiles || []).map(
          (profile: { id: string; name: string; apiProvider?: string }) => ({
            id: profile.id,
            name: profile.name,
            apiProvider: profile.apiProvider,
            isActive: data.activeProfile?.id === profile.id,
          }),
        );

        setProfilesData({
          profiles,
          activeProfile: profiles.find((p: Profile) => p.isActive),
        });
        setIsLoading(false);
        return;
      }

      throw new Error("Failed to fetch profiles");
    } catch (err) {
      console.warn("Failed to fetch profiles from API:", err);
      setError("Profiles API unavailable");
      // Set empty profiles list on error
      setProfilesData({ profiles: [] });
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl, extensionId]);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  return {
    ...profilesData,
    isLoading,
    error,
    refetch: fetchProfiles,
  };
};
