import React, { useEffect, useRef } from "react";

import type { Message as MessageType } from "../types/chat";
import { scrollToBottom } from "../utils/chatHelpers";
import { Message } from "./Message";

interface MessageListProps {
  messages: MessageType[];
  onSuggestionClick: (suggestion: string) => void;
  showTyping?: boolean;
}

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  onSuggestionClick,
  showTyping = false,
}) => {
  const chatMessagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollToBottom(chatMessagesRef.current);
  }, [messages, showTyping]);

  if (messages.length === 0) {
    return (
      <div
        ref={chatMessagesRef}
        className="flex-1 overflow-y-auto p-3 sm:p-5 flex flex-col gap-3 sm:gap-4 scrollbar-thin scrollbar-thumb-white/30 scrollbar-track-white/10"
      >
        <div className="flex-1 flex flex-col items-center justify-center text-center text-white/80 px-4 sm:px-10">
          <h2 className="text-2xl sm:text-3xl font-light mb-3">
            Welcome to Roomote Control
          </h2>
          <p className="text-base sm:text-lg opacity-80 max-w-md leading-relaxed">
            Control your RooCode tasks remotely. Start by typing your message
            below!
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={chatMessagesRef}
      className="flex-1 overflow-y-auto p-3 sm:p-5 flex flex-col gap-3 sm:gap-4 scrollbar-thin scrollbar-thumb-white/30 scrollbar-track-white/10 overscroll-contain"
    >
      {messages.map((message) => (
        <Message
          key={message.id}
          message={message}
          onSuggestionClick={onSuggestionClick}
        />
      ))}
    </div>
  );
};
