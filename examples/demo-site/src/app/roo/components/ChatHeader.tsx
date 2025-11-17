import React, { useState } from "react";

interface ChatHeaderProps {
  onNewChat: () => void;
  hasMessages: boolean;
  isConnected?: boolean;
  connectionUrl?: string | null;
  onDisconnect?: () => void;
  workspace?: string | null;
  agentMaestroVersion?: string | null;
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({
  onNewChat,
  hasMessages,
  isConnected = false,
  connectionUrl = null,
  onDisconnect,
  workspace = null,
  agentMaestroVersion = null,
}) => {
  const [showConnectionInfo, setShowConnectionInfo] = useState(false);

  const getDisplayUrl = (url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return url;
    }
  };

  const getWorkspaceName = (workspacePath: string) => {
    // Extract just the folder name from the full path
    const parts = workspacePath.split("/");
    return parts[parts.length - 1] || workspacePath;
  };

  return (
    <div className="bg-white/95 backdrop-blur-md px-3 sm:px-5 py-3 sm:py-4 flex justify-between items-center shadow-lg safe-area-top">
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <span className="text-lg sm:text-xl flex-shrink-0">🎮</span>
        <div className="min-w-0">
          <h1 className="text-base sm:text-xl font-normal text-gray-800 truncate">
            <span className="hidden sm:inline">Roomote Control</span>
            <span className="sm:hidden">Roomote</span>
          </h1>
          {isConnected && connectionUrl && (
            <div className="flex flex-col">
              <button
                onClick={() => setShowConnectionInfo(!showConnectionInfo)}
                className="text-xs text-green-600 flex items-center gap-1 hover:text-green-700"
              >
                <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                <span className="truncate max-w-[120px] sm:max-w-[200px]">
                  {getDisplayUrl(connectionUrl)}
                </span>
              </button>
              {workspace && (
                <span
                  className="text-xs text-gray-500 truncate max-w-[150px] sm:max-w-[250px]"
                  title={workspace}
                >
                  📁 {getWorkspaceName(workspace)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {isConnected && onDisconnect && (
          <button
            onClick={onDisconnect}
            className="px-2 sm:px-3 py-1.5 sm:py-2 rounded-full text-xs sm:text-sm font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 transition-all"
            title="Disconnect"
          >
            <span className="hidden sm:inline">Disconnect</span>
            <span className="sm:hidden">⏏</span>
          </button>
        )}
        <button
          onClick={onNewChat}
          disabled={!hasMessages}
          className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded-full text-xs sm:text-sm font-medium transition-all ${
            !hasMessages
              ? "opacity-50 pointer-events-none bg-blue-500 text-white"
              : "bg-blue-500 text-white hover:bg-blue-600 active:scale-95 sm:hover:-translate-y-0.5"
          }`}
        >
          <span className="hidden sm:inline">✨ New Chat</span>
          <span className="sm:hidden">✨ New</span>
        </button>
      </div>

      {/* Connection info modal */}
      {showConnectionInfo && connectionUrl && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={() => setShowConnectionInfo(false)}
        >
          <div
            className="bg-white rounded-lg p-4 max-w-sm w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-medium text-gray-900 mb-2">Connection Info</h3>
            <div className="space-y-2">
              <div>
                <span className="text-xs text-gray-500">API Endpoint:</span>
                <p className="text-sm text-gray-600 break-all">
                  {connectionUrl}
                </p>
              </div>
              {agentMaestroVersion && (
                <div>
                  <span className="text-xs text-gray-500">
                    Agent Maestro Version:
                  </span>
                  <p className="text-sm text-gray-600">{agentMaestroVersion}</p>
                </div>
              )}
              {workspace && (
                <div>
                  <span className="text-xs text-gray-500">
                    Active Workspace:
                  </span>
                  <p className="text-sm text-gray-600 break-all">{workspace}</p>
                </div>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              {onDisconnect && (
                <button
                  onClick={() => {
                    onDisconnect();
                    setShowConnectionInfo(false);
                  }}
                  className="px-3 py-1.5 text-sm bg-red-100 text-red-700 rounded-lg hover:bg-red-200"
                >
                  Disconnect
                </button>
              )}
              <button
                onClick={() => setShowConnectionInfo(false)}
                className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
