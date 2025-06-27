import { useCallback, useRef } from "react";
import { useChatState } from "./useChatState";
import { useStatusManager } from "./useStatusManager";
import { useApiClient } from "./useApiClient";
import { useMessageHandler } from "./useMessageHandler";
import {
  createMessage,
  isApprovalAction,
  focusTextarea,
  resetTextarea,
} from "../utils/chatHelpers";
import { STATUS_MESSAGES, SUGGESTION_ACTIONS } from "../utils/constants";

export const useChat = () => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const chatState = useChatState();
  const statusManager = useStatusManager();
  const apiClient = useApiClient();

  const focusTextareaHelper = useCallback(() => {
    focusTextarea(textareaRef.current);
  }, []);

  const messageHandler = useMessageHandler({
    addMessage: chatState.addMessage,
    updateMessage: chatState.updateMessage,
    setCurrentTaskId: chatState.setCurrentTaskId,
    setIsWaitingForResponse: chatState.setIsWaitingForResponse,
    showStatusMessage: statusManager.showStatusMessage,
    focusTextarea: focusTextareaHelper,
  });

  const handleNewChat = useCallback(() => {
    chatState.resetChatState();
    resetTextarea(textareaRef.current);
    focusTextarea(textareaRef.current);
  }, [chatState]);

  const handleSuggestionClick = useCallback(
    async (suggestion: string) => {
      if (chatState.isWaitingForResponse) return;

      // Handle Approve/Reject actions for MCP server requests
      if (isApprovalAction(suggestion)) {
        if (!chatState.currentTaskId) {
          console.error("No current task ID for approve/reject action");
          return;
        }

        chatState.setIsWaitingForResponse(true);
        statusManager.showStatusMessage(
          suggestion === SUGGESTION_ACTIONS.APPROVE
            ? STATUS_MESSAGES.APPROVING
            : STATUS_MESSAGES.REJECTING,
        );

        try {
          const success = await apiClient.sendTaskAction(
            chatState.currentTaskId,
            suggestion,
          );

          if (success) {
            statusManager.showStatusMessage(
              suggestion === SUGGESTION_ACTIONS.APPROVE
                ? STATUS_MESSAGES.APPROVED
                : STATUS_MESSAGES.REJECTED,
            );

            // Add a user message to show the action taken
            const userMessage = createMessage(suggestion, true);
            chatState.addMessage(userMessage);
          } else {
            throw new Error("Failed to process action");
          }
        } catch (error) {
          console.error("Error handling approve/reject:", error);
          statusManager.showStatusMessage(STATUS_MESSAGES.ERROR_PROCESSING);
        } finally {
          chatState.setIsWaitingForResponse(false);
          focusTextarea(textareaRef.current);
        }
        return;
      }

      // Handle regular suggestions
      chatState.setInputValue(suggestion);
      setTimeout(() => sendMessage(suggestion), 100);
    },
    [chatState, statusManager, apiClient],
  );

  const sendMessage = useCallback(
    async (messageText?: string) => {
      const message = messageText || chatState.inputValue.trim();
      if (!message || chatState.isWaitingForResponse) return;

      // Add user message
      const userMessage = createMessage(message, true);
      chatState.addMessage(userMessage);
      chatState.setInputValue("");
      resetTextarea(textareaRef.current);

      // Update UI state
      chatState.setWaitingState(true);
      messageHandler.resetMessageState();

      try {
        statusManager.showStatusMessage(STATUS_MESSAGES.CONNECTING);

        const response = await apiClient.sendMessage(
          message,
          chatState.selectedMode,
          chatState.selectedExtension,
          chatState.currentTaskId || undefined,
        );

        chatState.setShowTyping(false);
        statusManager.showStatusMessage(STATUS_MESSAGES.RECEIVING);

        const sseReader = apiClient.createSSEReader(response);

        while (true) {
          const { done, events } = await sseReader.read();
          if (done) break;

          for (const { event, data } of events) {
            messageHandler.handleEvent(event, data);
          }
        }
      } catch (error) {
        console.error("Chat error:", error);
        chatState.setShowTyping(false);
        statusManager.showStatusMessage(
          `Connection error: ${error instanceof Error ? error.message : "Unknown error"}`,
        );

        const errorMessage = createMessage(
          "Sorry, I encountered a connection error. Please try again.",
          false,
        );

        chatState.addMessage(errorMessage);
        chatState.setIsWaitingForResponse(false);
        focusTextarea(textareaRef.current);
      }
    },
    [chatState, statusManager, apiClient, messageHandler],
  );

  return {
    // State
    messages: chatState.messages,
    inputValue: chatState.inputValue,
    isWaitingForResponse: chatState.isWaitingForResponse,
    showTyping: chatState.showTyping,
    statusMessage: statusManager.statusMessage,
    showStatus: statusManager.showStatus,
    selectedMode: chatState.selectedMode,
    selectedExtension: chatState.selectedExtension,

    // Refs
    textareaRef,

    // Actions
    handleNewChat,
    handleSuggestionClick,
    sendMessage,
    setInputValue: chatState.setInputValue,
    setSelectedMode: chatState.setSelectedMode,
    setSelectedExtension: chatState.setSelectedExtension,
  };
};
