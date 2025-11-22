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
import { useTaskActions } from "./hooks/useTaskActions";
import { useTaskHistory } from "./hooks/useTaskHistory";

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
    currentTaskId,

    // Refs
    // textareaRef, // Managed internally by useChat

    // Actions
    handleNewChat,
    handleSuggestionClick,
    sendMessage,
    setInputValue,
    setSelectedMode,
    setSelectedExtension,
    setCurrentTaskId,
    clearMessages,
    addMessage,
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

  const {
    tasks: taskHistory,
    totalTaskCount,
    isLoading: isLoadingTasks,
    error: taskError,
    refetch: refetchTasks,
    fetchTaskDetail,
  } = useTaskHistory({
    apiBaseUrl: apiConfig.baseUrl,
    extensionId: selectedExtension,
    autoFetch: true,
    filterByWorkspace: apiConfig.workspace || undefined, // Filter to current workspace
  });

  const { cancelTask, resumeTask } = useTaskActions({
    apiBaseUrl: apiConfig.baseUrl,
    extensionId: selectedExtension,
  });

  // Task management handlers
  const handleSelectTask = React.useCallback(
    async (taskId: string) => {
      try {
        // Fetch task details and load conversation history
        const taskDetail = await fetchTaskDetail(taskId);
        if (taskDetail && taskDetail.messages) {
          // Clear current messages
          clearMessages();

          // Convert conversation history to Message format
          taskDetail.messages.forEach((item) => {
            const isUser =
              item.say === "user_feedback" || item.ask === "followup";
            const content = item.text || item.reasoning || "";

            if (content) {
              const message = {
                id: `${taskId}-${item.ts}`,
                content,
                isUser,
                timestamp: new Date(item.ts).toLocaleTimeString(),
              };
              addMessage(message);
            }
          });

          // Set the current task ID for subsequent messages
          setCurrentTaskId(taskId);
        } else {
          // Just set the task ID if we couldn't load history
          setCurrentTaskId(taskId);
        }
      } catch (error) {
        console.error("Failed to load task conversation history:", error);
        // Still set the task ID so user can continue with the task
        setCurrentTaskId(taskId);
      }
    },
    [fetchTaskDetail, clearMessages, addMessage, setCurrentTaskId],
  );

  const handleCancelTask = React.useCallback(
    async (taskId: string) => {
      try {
        const result = await cancelTask(taskId);
        if (result.success) {
          // Refresh task list after cancellation
          refetchTasks();
        } else {
          console.error("Failed to cancel task:", result.error);
        }
      } catch (error) {
        console.error("Error cancelling task:", error);
      }
    },
    [cancelTask, refetchTasks],
  );

  const handleResumeTask = React.useCallback(
    async (taskId: string) => {
      try {
        const result = await resumeTask(taskId);
        if (result.success) {
          // Load conversation history after successful resume
          await handleSelectTask(taskId);
          refetchTasks();
        } else {
          console.error("Failed to resume task:", result.error);
        }
      } catch (error) {
        console.error("Error resuming task:", error);
      }
    },
    [resumeTask, handleSelectTask, refetchTasks],
  );

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
          taskHistory={taskHistory}
          currentTaskId={currentTaskId}
          isLoadingTasks={isLoadingTasks}
          taskError={taskError}
          onRefreshTasks={refetchTasks}
          onSelectTask={handleSelectTask}
          onCancelTask={handleCancelTask}
          onResumeTask={handleResumeTask}
          onNewChat={handleNewChat}
          totalTaskCount={totalTaskCount}
          currentWorkspace={apiConfig.workspace || undefined}
        />

        <StatusIndicator show={showStatus} message={statusMessage} />
      </div>
    </ErrorBoundary>
  );
}
