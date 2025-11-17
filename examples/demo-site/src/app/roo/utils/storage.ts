const STORAGE_KEYS = {
  API_BASE_URL: "roomote_api_base_url",
  LAST_CONNECTED: "roomote_last_connected",
  SAVED_WORKSPACES: "roomote_saved_workspaces",
} as const;

export interface SavedWorkspace {
  url: string;
  workspace: string;
  workspaceName: string; // Just the folder name
  version: string;
  lastConnected: string;
}

export const storage = {
  getApiBaseUrl(): string | null {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(STORAGE_KEYS.API_BASE_URL);
  },

  setApiBaseUrl(url: string): void {
    if (typeof window === "undefined") return;
    localStorage.setItem(STORAGE_KEYS.API_BASE_URL, url);
    localStorage.setItem(STORAGE_KEYS.LAST_CONNECTED, new Date().toISOString());
  },

  clearApiBaseUrl(): void {
    if (typeof window === "undefined") return;
    localStorage.removeItem(STORAGE_KEYS.API_BASE_URL);
    localStorage.removeItem(STORAGE_KEYS.LAST_CONNECTED);
  },

  getLastConnected(): string | null {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(STORAGE_KEYS.LAST_CONNECTED);
  },

  getSavedWorkspaces(): SavedWorkspace[] {
    if (typeof window === "undefined") return [];
    const saved = localStorage.getItem(STORAGE_KEYS.SAVED_WORKSPACES);
    if (!saved) return [];
    try {
      return JSON.parse(saved);
    } catch {
      return [];
    }
  },

  saveWorkspace(workspace: SavedWorkspace): void {
    if (typeof window === "undefined") return;
    const workspaces = this.getSavedWorkspaces();
    // Update existing or add new
    const index = workspaces.findIndex((w) => w.url === workspace.url);
    if (index >= 0) {
      workspaces[index] = workspace;
    } else {
      workspaces.push(workspace);
    }
    localStorage.setItem(
      STORAGE_KEYS.SAVED_WORKSPACES,
      JSON.stringify(workspaces),
    );
  },

  removeWorkspace(url: string): void {
    if (typeof window === "undefined") return;
    const workspaces = this.getSavedWorkspaces();
    const filtered = workspaces.filter((w) => w.url !== url);
    localStorage.setItem(
      STORAGE_KEYS.SAVED_WORKSPACES,
      JSON.stringify(filtered),
    );
  },
};
