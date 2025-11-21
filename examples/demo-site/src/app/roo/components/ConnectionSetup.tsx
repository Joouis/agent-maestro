import React, { useEffect, useState } from "react";

import { usePortScanner } from "../hooks/usePortScanner";
import { DEFAULT_API_BASE_URL } from "../utils/constants";
import { SavedWorkspace, storage } from "../utils/storage";

interface ConnectionSetupProps {
  onConnect: (url: string) => Promise<boolean>;
  isChecking: boolean;
  error: string | null;
  savedUrl: string | null;
  lastConnected: string | null;
}

export const ConnectionSetup: React.FC<ConnectionSetupProps> = ({
  onConnect,
  isChecking,
  error,
  savedUrl,
  lastConnected,
}) => {
  const [url, setUrl] = useState(savedUrl || DEFAULT_API_BASE_URL);
  const [showManualInput, setShowManualInput] = useState(false);
  const [savedWorkspaces, setSavedWorkspaces] = useState<SavedWorkspace[]>([]);
  const {
    instances,
    isScanning,
    scanPorts,
    error: scanError,
  } = usePortScanner();

  // Load saved workspaces and auto-scan on mount
  useEffect(() => {
    setSavedWorkspaces(storage.getSavedWorkspaces());
    scanPorts(); // Auto-scan on load
  }, [scanPorts]);

  useEffect(() => {
    if (savedUrl) {
      setUrl(savedUrl);
    }
  }, [savedUrl]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedUrl = url.trim();

    // Basic validation
    if (!trimmedUrl) return;

    const parsed = new URL(trimmedUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      // Invalid protocol - don't proceed
      return;
    }

    await onConnect(trimmedUrl);
  };

  const handleQuickConnect = async (preset: string) => {
    setUrl(preset);
    await onConnect(preset);
  };

  const handleRemoveSaved = (workspaceUrl: string) => {
    storage.removeWorkspace(workspaceUrl);
    setSavedWorkspaces(storage.getSavedWorkspaces());
  };

  const formatLastConnected = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 sm:p-8">
        <div className="text-center mb-6">
          <div className="text-4xl mb-3">🎮</div>
          <h1 className="text-2xl font-bold text-gray-900">Roomote Control</h1>
          <p className="text-gray-600 mt-2 text-sm">
            Select a workspace to connect
          </p>
        </div>

        {/* Discovered Instances */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-gray-700">
              Available Workspaces
            </h3>
            <button
              onClick={scanPorts}
              disabled={isScanning}
              className="text-xs text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
            >
              {isScanning ? (
                <>
                  <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                      fill="none"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  Scanning...
                </>
              ) : (
                <>
                  <span>🔄</span>
                  Rescan
                </>
              )}
            </button>
          </div>

          {isScanning && instances.length === 0 && (
            <div className="bg-gray-50 rounded-lg p-4 text-center">
              <p className="text-sm text-gray-600">Scanning local ports...</p>
            </div>
          )}

          {!isScanning && instances.length === 0 && (
            <div className="bg-yellow-50 rounded-lg p-3 text-sm text-yellow-700">
              {scanError || "No Agent Maestro instances found on localhost"}
            </div>
          )}

          {instances.length > 0 && (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {instances.map((instance) => (
                <button
                  key={instance.port}
                  onClick={() => handleQuickConnect(instance.url)}
                  disabled={isChecking}
                  className="w-full text-left p-3 bg-green-50 hover:bg-green-100 rounded-lg border border-green-200 disabled:opacity-50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-green-600">📁</span>
                    <span className="font-medium text-gray-900">
                      {instance.workspaceName}
                    </span>
                    <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">
                      :{instance.port}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1 truncate">
                    {instance.workspace}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    v{instance.version}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Saved Workspaces (Remote/Previous) */}
        {savedWorkspaces.length > 0 && (
          <div className="mb-4">
            <h3 className="text-sm font-medium text-gray-700 mb-2">
              Recent Connections
            </h3>
            <div className="space-y-2 max-h-32 overflow-y-auto">
              {savedWorkspaces
                .filter((w) => !instances.some((i) => i.url === w.url))
                .sort(
                  (a, b) =>
                    new Date(b.lastConnected).getTime() -
                    new Date(a.lastConnected).getTime(),
                )
                .slice(0, 3)
                .map((workspace) => (
                  <div
                    key={workspace.url}
                    className="flex items-center gap-2 p-2 bg-blue-50 rounded-lg"
                  >
                    <button
                      onClick={() => handleQuickConnect(workspace.url)}
                      disabled={isChecking}
                      className="flex-1 text-left disabled:opacity-50"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-blue-600">📁</span>
                        <span className="font-medium text-gray-900 text-sm">
                          {workspace.workspaceName}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 truncate">
                        {workspace.url}
                      </div>
                      <div className="text-xs text-gray-400">
                        {formatLastConnected(workspace.lastConnected)}
                      </div>
                    </button>
                    <button
                      onClick={() => handleRemoveSaved(workspace.url)}
                      className="text-gray-400 hover:text-red-500 p-1"
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Manual URL Input Toggle */}
        <div className="mt-4">
          <button
            onClick={() => setShowManualInput(!showManualInput)}
            className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
          >
            <span>{showManualInput ? "▼" : "▶"}</span>
            Enter URL Manually
          </button>

          {showManualInput && (
            <form onSubmit={handleConnect} className="mt-3 space-y-3">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://your-tunnel.ngrok.io"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-gray-900 text-sm"
                disabled={isChecking}
              />
              <button
                type="submit"
                disabled={isChecking || !url.trim()}
                className="w-full bg-indigo-600 text-white py-2 px-4 rounded-lg font-medium hover:bg-indigo-700 disabled:bg-indigo-300 transition-colors flex items-center justify-center gap-2 text-sm"
              >
                {isChecking ? "Connecting..." : "Connect"}
              </button>
            </form>
          )}
        </div>

        {error && (
          <div className="mt-4 bg-red-50 text-red-700 p-3 rounded-lg text-sm">
            {error}
          </div>
        )}
      </div>
    </div>
  );
};
