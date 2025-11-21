"use client";

import React, { useEffect, useState } from "react";

import { ChatHeader } from "./components/ChatHeader";
import { ChatInput } from "./components/ChatInput";
import { ConnectionSetup } from "./components/ConnectionSetup";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { MessageList } from "./components/MessageList";
import { StatusIndicator } from "./components/StatusIndicator";
import { useApiConfig } from "./hooks/useApiConfig";
import { useAutoApprove } from "./hooks/useAutoApprove";
import { useChat } from "./hooks/useChat";
import { useModes } from "./hooks/useModes";
import { useProfiles } from "./hooks/useProfiles";

export default function RooPage() {
  const [isHydrated, setIsHydrated] = useState(false);

  const apiConfig = useApiConfig();

  const {
    // State
    messages,
    inputValue,
    isWaitingForResponse,
    showTyping,
    statusMessage,
    showStatus,
    selectedMode,
    selectedExtension,

    // Refs
    // textareaRef, // Managed internally by useChat

    // Actions
    handleNewChat,
    handleSuggestionClick,
    sendMessage,
    setInputValue,
    setSelectedMode,
    setSelectedExtension,
  } = useChat({ apiBaseUrl: apiConfig.baseUrl });

  const { modes, isLoading: isLoadingModes } = useModes({
    apiBaseUrl: apiConfig.baseUrl,
    extensionId: selectedExtension,
  });

  const { profiles, isLoading: isLoadingProfiles } = useProfiles({
    apiBaseUrl: apiConfig.baseUrl,
    extensionId: selectedExtension,
  });

  const {
    settings: autoApproveSettings,
    isLoading: isLoadingAutoApprove,
    isUpdating: isUpdatingAutoApprove,
    error: autoApproveError,
    updateSettings: updateAutoApproveSettings,
  } = useAutoApprove({
    apiBaseUrl: apiConfig.baseUrl,
    extensionId: selectedExtension,
  });

  // Handle hydration to avoid SSR mismatch
  useEffect(() => {
    setIsHydrated(true);

    // Auto-reconnect if we have a saved URL
    if (apiConfig.baseUrl && !apiConfig.isConnected) {
      apiConfig.reconnect();
    }
  }, []);

  // Show loading state during hydration
  if (!isHydrated) {
    return (
      <div className="h-screen flex items-center justify-center bg-gradient-to-br from-indigo-500 to-purple-600">
        <div className="text-white text-lg">Loading...</div>
      </div>
    );
  }

  // Show connection setup if not connected
  if (!apiConfig.isConnected) {
    return (
      <ErrorBoundary>
        <ConnectionSetup
          onConnect={apiConfig.connect}
          isChecking={apiConfig.isChecking}
          error={apiConfig.error}
          savedUrl={apiConfig.baseUrl}
          lastConnected={apiConfig.lastConnected}
        />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <div className="h-screen flex flex-col bg-gradient-to-br from-indigo-500 to-purple-600">
        <ChatHeader
          onNewChat={handleNewChat}
          hasMessages={messages.length > 0}
          isConnected={apiConfig.isConnected}
          connectionUrl={apiConfig.baseUrl}
          onDisconnect={apiConfig.disconnect}
          workspace={apiConfig.workspace}
          agentMaestroVersion={apiConfig.agentMaestroVersion}
        />

        <MessageList
          messages={messages}
          onSuggestionClick={handleSuggestionClick}
          showTyping={showTyping}
        />

        <ChatInput
          value={inputValue}
          onChange={setInputValue}
          onSend={sendMessage}
          disabled={isWaitingForResponse}
          selectedMode={selectedMode}
          onModeChange={setSelectedMode}
          selectedExtension={selectedExtension}
          onExtensionChange={setSelectedExtension}
          hasMessages={messages.length > 0}
          modes={modes}
          isLoadingModes={isLoadingModes}
          apiBaseUrl={apiConfig.baseUrl}
          profiles={profiles}
          isLoadingProfiles={isLoadingProfiles}
          autoApproveSettings={autoApproveSettings}
          onUpdateAutoApprove={updateAutoApproveSettings}
          isLoadingAutoApprove={isLoadingAutoApprove}
          isUpdatingAutoApprove={isUpdatingAutoApprove}
          autoApproveError={autoApproveError}
        />

        <StatusIndicator show={showStatus} message={statusMessage} />
      </div>
    </ErrorBoundary>
  );
}
