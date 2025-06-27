import React, { useRef, useEffect } from "react";
import {
  autoResizeTextarea,
  resetTextarea,
  focusTextarea,
} from "../utils/chatHelpers";
import { UI_CONFIG } from "../utils/constants";
import { ModeSelector } from "./ModeSelector";
import { ExtensionSelector } from "./ExtensionSelector";

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  placeholder?: string;
  selectedMode: string;
  onModeChange: (mode: string) => void;
  selectedExtension: string;
  onExtensionChange: (extension: string) => void;
  hasMessages: boolean;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  value,
  onChange,
  onSend,
  disabled,
  placeholder = "Ask me anything...",
  selectedMode,
  onModeChange,
  selectedExtension,
  onExtensionChange,
  hasMessages,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      focusTextarea(textareaRef.current);
    }
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    autoResizeTextarea(e.target, UI_CONFIG.TEXTAREA_MAX_HEIGHT);
  };

  const handleSend = () => {
    onSend();
    if (textareaRef.current) {
      resetTextarea(textareaRef.current);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = value.trim() && !disabled;

  return (
    <div className="bg-white/95 backdrop-blur-md pl-20 pr-15 py-5 border-t border-black/10">
      <div className="max-w-4xl mx-auto">
        {/* Input Area */}
        <div className="flex gap-3 items-end">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder={disabled ? "Waiting for response..." : placeholder}
            rows={1}
            className="flex-1 min-h-12 max-h-30 p-4 border-2 border-gray-200 rounded-3xl text-black resize-none outline-none transition-colors focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed scrollbar-hide"
          />
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="w-11 h-11 rounded-full bg-blue-500 text-white flex items-center justify-center text-lg transition-all hover:bg-blue-600 hover:scale-105 disabled:bg-gray-400 disabled:cursor-not-allowed disabled:transform-none"
          >
            ➤
          </button>
          <div className="flex items-center gap-4 ml-2">
            {/* <span className="text-sm text-gray-600 font-medium whitespace-nowrap">Mode:</span> */}
            <ModeSelector
              selectedMode={selectedMode}
              onModeChange={onModeChange}
              disabled={disabled || hasMessages}
            />
            <ExtensionSelector
              selectedExtension={selectedExtension}
              onExtensionChange={onExtensionChange}
              disabled={disabled || hasMessages}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
