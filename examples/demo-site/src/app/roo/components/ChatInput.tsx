import React, { useEffect, useRef } from "react";

import {
  autoResizeTextarea,
  focusTextarea,
  resetTextarea,
} from "../utils/chatHelpers";
import { UI_CONFIG } from "../utils/constants";
import { ExtensionSelector } from "./ExtensionSelector";
import { ModeSelector } from "./ModeSelector";
import { ProviderSelector } from "./ProviderSelector";

interface Mode {
  slug: string;
  name: string;
  roleDefinition?: string;
  customInstructions?: string;
  groups?: any[];
  source?: "builtin" | "custom";
  whenToUse?: string;
}

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
  modes?: Mode[];
  isLoadingModes?: boolean;
  apiBaseUrl?: string | null;
  currentProvider?: string;
  currentModel?: string;
  providers?: string[];
  isLoadingProviders?: boolean;
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
  modes,
  isLoadingModes,
  apiBaseUrl,
  currentProvider,
  currentModel,
  providers = [],
  isLoadingProviders = false,
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
    <div className="bg-white/95 backdrop-blur-md px-3 sm:px-6 md:pl-20 md:pr-15 py-3 sm:py-5 border-t border-black/10 safe-area-bottom">
      <div className="max-w-4xl mx-auto">
        {/* Mode selectors - stacked on mobile, inline on desktop */}
        <div className="flex flex-wrap gap-2 mb-3 sm:hidden">
          <ModeSelector
            selectedMode={selectedMode}
            onModeChange={onModeChange}
            disabled={disabled || hasMessages}
            modes={modes}
            isLoadingModes={isLoadingModes}
          />
          <ProviderSelector
            currentProvider={currentProvider}
            currentModel={currentModel}
            providers={providers}
            isLoading={isLoadingProviders}
            disabled={disabled}
          />
          <ExtensionSelector
            selectedExtension={selectedExtension}
            onExtensionChange={onExtensionChange}
            disabled={disabled || hasMessages}
            apiBaseUrl={apiBaseUrl}
          />
        </div>

        {/* Input Area */}
        <div className="flex gap-2 sm:gap-3 items-end">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder={disabled ? "Waiting for response..." : placeholder}
            rows={1}
            className="flex-1 max-h-30 px-3 sm:px-4 py-2 border-2 border-gray-200 rounded-2xl sm:rounded-3xl text-black text-base sm:text-sm resize-none outline-none transition-colors focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed scrollbar-hide"
          />
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="size-10 sm:size-9 rounded-full bg-blue-500 text-white flex items-center justify-center text-lg transition-all hover:bg-blue-600 active:scale-95 sm:hover:scale-105 disabled:bg-gray-400 disabled:cursor-not-allowed disabled:transform-none flex-shrink-0"
          >
            ➤
          </button>
          {/* Desktop mode selectors */}
          <div className="hidden sm:flex items-center gap-4 ml-2">
            <ModeSelector
              selectedMode={selectedMode}
              onModeChange={onModeChange}
              disabled={disabled || hasMessages}
              modes={modes}
              isLoadingModes={isLoadingModes}
            />
            <ProviderSelector
              currentProvider={currentProvider}
              currentModel={currentModel}
              providers={providers}
              isLoading={isLoadingProviders}
              disabled={disabled}
            />
            <ExtensionSelector
              selectedExtension={selectedExtension}
              onExtensionChange={onExtensionChange}
              disabled={disabled || hasMessages}
              apiBaseUrl={apiBaseUrl}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
