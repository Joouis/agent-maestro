import { useCallback, useState } from "react";

import type { Message } from "../types/chat";
import { DEFAULT_MODE } from "../utils/constants";

export const useChatState = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [showTyping, setShowTyping] = useState(false);
  const [selectedMode, setSelectedMode] = useState(DEFAULT_MODE);
  const [selectedExtension, setSelectedExtension] = useState<
    string | undefined
  >(
    undefined, // Will be set by ExtensionSelector after detecting available extensions
  );

  const addMessage = useCallback((message: Message) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const updateMessage = useCallback(
    (messageId: string, updates: Partial<Message>) => {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId ? { ...msg, ...updates } : msg,
        ),
      );
    },
    [],
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  const resetChatState = useCallback(() => {
    setMessages([]);
    setCurrentTaskId(null);
    setIsWaitingForResponse(false);
    setInputValue("");
    setShowTyping(false);
    setSelectedMode(DEFAULT_MODE);
    // Keep selected extension when resetting chat
  }, []);

  const setWaitingState = useCallback((waiting: boolean) => {
    setIsWaitingForResponse(waiting);
    setShowTyping(waiting);
  }, []);

  return {
    // State
    messages,
    inputValue,
    isWaitingForResponse,
    currentTaskId,
    showTyping,
    selectedMode,
    selectedExtension,

    // Setters
    setInputValue,
    setIsWaitingForResponse,
    setCurrentTaskId,
    setShowTyping,
    setSelectedMode,
    setSelectedExtension,

    // Actions
    addMessage,
    updateMessage,
    clearMessages,
    resetChatState,
    setWaitingState,
  };
};
