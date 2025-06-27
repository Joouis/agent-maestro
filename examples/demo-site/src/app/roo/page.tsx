"use client";

import React from "react";
import { useChat } from "./hooks/useChat";
import { ChatHeader } from "./components/ChatHeader";
import { MessageList } from "./components/MessageList";
import { ChatInput } from "./components/ChatInput";
import { StatusIndicator } from "./components/StatusIndicator";

export default function RooPage() {
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
    textareaRef,

    // Actions
    handleNewChat,
    handleSuggestionClick,
    sendMessage,
    setInputValue,
    setSelectedMode,
    setSelectedExtension,
  } = useChat();

  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-indigo-500 to-purple-600">
      <ChatHeader onNewChat={handleNewChat} hasMessages={messages.length > 0} />

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
      />

      <StatusIndicator show={showStatus} message={statusMessage} />
    </div>
  );
}
