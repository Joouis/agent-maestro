import React, { useEffect, useRef, useState } from "react";

import type { AutoApproveSettings } from "../hooks/useAutoApprove";

interface AutoApproveSettingsProps {
  settings: AutoApproveSettings;
  onUpdateSettings: (
    settings: Partial<AutoApproveSettings>,
  ) => Promise<boolean>;
  isLoading?: boolean;
  isUpdating?: boolean;
  disabled?: boolean;
  error?: string | null;
}

// CSS class constants
const BUTTON_BASE = "text-sm transition-colors";
const CHECKBOX_BASE =
  "w-4 h-4 text-purple-600 bg-gray-100 border-gray-300 rounded focus:ring-purple-500";
const LABEL_BASE = "flex items-center justify-between cursor-pointer group";
const LABEL_TEXT = "text-sm text-gray-700 group-hover:text-purple-600";

export const AutoApproveSettingsComponent: React.FC<
  AutoApproveSettingsProps
> = ({
  settings,
  onUpdateSettings,
  isLoading = false,
  isUpdating = false,
  disabled = false,
  error = null,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Keyboard navigation - Escape to close dropdown
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isOpen) {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [isOpen]);

  const handleToggle = async (key: keyof AutoApproveSettings) => {
    if (disabled || isUpdating) return;

    // Input validation - check key exists in settings
    if (!(key in settings)) {
      console.error(`Invalid settings key: ${key}`);
      return;
    }

    await onUpdateSettings({ [key]: !settings[key] });
  };

  const handleQuickToggle = async () => {
    if (disabled || isUpdating) return;
    // Toggle the main three: Read, Write, Execute
    const allEnabled =
      settings.alwaysAllowReadOnly &&
      settings.alwaysAllowWrite &&
      settings.alwaysAllowExecute;
    await onUpdateSettings({
      alwaysAllowReadOnly: !allEnabled,
      alwaysAllowWrite: !allEnabled,
      alwaysAllowExecute: !allEnabled,
    });
  };

  const getDisplayText = () => {
    const enabled: string[] = [];
    if (settings.alwaysAllowReadOnly) enabled.push("Read");
    if (settings.alwaysAllowWrite) enabled.push("Write");
    if (settings.alwaysAllowExecute) enabled.push("Exec");

    if (enabled.length === 0) return "Auto-approve disabled";
    if (enabled.length === 3) return "Auto-approve: Read, Write, Exec";
    return `Auto-approve: ${enabled.join(", ")}`;
  };

  const isAnyEnabled =
    settings.alwaysAllowReadOnly ||
    settings.alwaysAllowWrite ||
    settings.alwaysAllowExecute;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <div className="animate-spin h-4 w-4 border-2 border-gray-300 border-t-gray-600 rounded-full" />
        <span>Loading...</span>
      </div>
    );
  }

  return (
    <div ref={dropdownRef} className="relative">
      {/* Error display */}
      {error && (
        <div className="mb-2 text-xs text-red-600 bg-red-50 px-2 py-1 rounded">
          {error}
        </div>
      )}

      {/* Quick toggle checkbox + dropdown trigger */}
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={isAnyEnabled}
            onChange={handleQuickToggle}
            disabled={disabled || isUpdating}
            className={`${CHECKBOX_BASE} disabled:opacity-50`}
            aria-label="Quick toggle auto-approve"
          />
          <button
            ref={triggerRef}
            onClick={() => setIsOpen(!isOpen)}
            disabled={disabled}
            className={`flex items-center gap-1 ${BUTTON_BASE} ${
              disabled ? "text-gray-400" : "text-gray-700 hover:text-purple-600"
            } ${isUpdating ? "opacity-50" : ""}`}
            aria-expanded={isOpen}
            aria-controls="auto-approve-dropdown"
            aria-haspopup="dialog"
          >
            <span className="truncate max-w-48">{getDisplayText()}</span>
            <svg
              className={`w-4 h-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
        </label>
        {isUpdating && (
          <div className="animate-spin h-3 w-3 border-2 border-purple-300 border-t-purple-600 rounded-full" />
        )}
      </div>

      {/* Dropdown panel */}
      {isOpen && (
        <div
          id="auto-approve-dropdown"
          role="dialog"
          aria-label="Auto-approve settings"
          className="absolute bottom-full left-0 mb-2 w-72 bg-white rounded-lg shadow-lg border border-gray-200 py-2 z-50"
        >
          <div className="px-3 py-2 border-b border-gray-100">
            <h3 className="font-medium text-gray-900 text-sm">
              Auto-Approve Settings
            </h3>
            <p className="text-xs text-gray-500 mt-1">
              Configure which actions to auto-approve
            </p>
          </div>

          <div className="px-3 py-2 space-y-3 max-h-64 overflow-y-auto">
            {/* Main approval toggle */}
            <label className={LABEL_BASE}>
              <span className={LABEL_TEXT}>Enable Auto-Approval</span>
              <input
                type="checkbox"
                checked={settings.autoApprovalEnabled}
                onChange={() => handleToggle("autoApprovalEnabled")}
                disabled={disabled || isUpdating}
                className={CHECKBOX_BASE}
                aria-label="Enable auto-approval"
              />
            </label>

            <div className="border-t border-gray-100 pt-2">
              <p className="text-xs text-gray-500 mb-2">File Operations</p>

              <label className={`${LABEL_BASE} mb-2`}>
                <span className={LABEL_TEXT}>Read Files</span>
                <input
                  type="checkbox"
                  checked={settings.alwaysAllowReadOnly}
                  onChange={() => handleToggle("alwaysAllowReadOnly")}
                  disabled={disabled || isUpdating}
                  className={CHECKBOX_BASE}
                  aria-label="Always allow read-only operations"
                />
              </label>

              <label className={`${LABEL_BASE} mb-2`}>
                <span className={LABEL_TEXT}>Write Files</span>
                <input
                  type="checkbox"
                  checked={settings.alwaysAllowWrite}
                  onChange={() => handleToggle("alwaysAllowWrite")}
                  disabled={disabled || isUpdating}
                  className={CHECKBOX_BASE}
                  aria-label="Always allow write operations"
                />
              </label>

              <label className={LABEL_BASE}>
                <span className={LABEL_TEXT}>Execute Commands</span>
                <input
                  type="checkbox"
                  checked={settings.alwaysAllowExecute}
                  onChange={() => handleToggle("alwaysAllowExecute")}
                  disabled={disabled || isUpdating}
                  className={CHECKBOX_BASE}
                  aria-label="Always allow command execution"
                />
              </label>
            </div>

            <div className="border-t border-gray-100 pt-2">
              <p className="text-xs text-gray-500 mb-2">Advanced</p>

              <label className={`${LABEL_BASE} mb-2`}>
                <span className={LABEL_TEXT}>Browser Actions</span>
                <input
                  type="checkbox"
                  checked={settings.alwaysAllowBrowser}
                  onChange={() => handleToggle("alwaysAllowBrowser")}
                  disabled={disabled || isUpdating}
                  className={CHECKBOX_BASE}
                  aria-label="Always allow browser actions"
                />
              </label>

              <label className={`${LABEL_BASE} mb-2`}>
                <span className={LABEL_TEXT}>MCP Tools</span>
                <input
                  type="checkbox"
                  checked={settings.alwaysAllowMcp}
                  onChange={() => handleToggle("alwaysAllowMcp")}
                  disabled={disabled || isUpdating}
                  className={CHECKBOX_BASE}
                  aria-label="Always allow MCP tools"
                />
              </label>

              <label className={`${LABEL_BASE} mb-2`}>
                <span className={LABEL_TEXT}>Mode Switching</span>
                <input
                  type="checkbox"
                  checked={settings.alwaysAllowModeSwitch}
                  onChange={() => handleToggle("alwaysAllowModeSwitch")}
                  disabled={disabled || isUpdating}
                  className={CHECKBOX_BASE}
                  aria-label="Always allow mode switching"
                />
              </label>

              <label className={LABEL_BASE}>
                <span className={LABEL_TEXT}>Subtasks</span>
                <input
                  type="checkbox"
                  checked={settings.alwaysAllowSubtasks}
                  onChange={() => handleToggle("alwaysAllowSubtasks")}
                  disabled={disabled || isUpdating}
                  className={CHECKBOX_BASE}
                  aria-label="Always allow subtasks"
                />
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
