import React, { useState } from "react";

import { MODES } from "../utils/constants";

interface Mode {
  slug: string;
  name: string;
  roleDefinition?: string;
  customInstructions?: string;
  groups?: any[];
  source?: "builtin" | "custom";
  whenToUse?: string;
}

interface ModeSelectorProps {
  selectedMode: string;
  onModeChange: (mode: string) => void;
  disabled: boolean;
  modes?: Mode[];
  isLoadingModes?: boolean;
}

export const ModeSelector: React.FC<ModeSelectorProps> = ({
  selectedMode,
  onModeChange,
  disabled,
  modes,
  isLoadingModes = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);

  // Use provided modes or fallback to hardcoded MODES
  const availableModes: Mode[] =
    modes && modes.length > 0
      ? modes
      : MODES.map((m) => ({
          slug: m.slug,
          name: m.name,
          whenToUse: m.whenToUse,
          groups: m.groups as any[],
          source: "builtin" as const,
        }));

  const selectedModeData = availableModes.find(
    (mode) => mode.slug === selectedMode,
  );

  const formatGroups = (groups: readonly any[]): string => {
    return groups
      .map((group) => {
        if (typeof group === "string") {
          return group;
        } else if (Array.isArray(group) && group.length === 2) {
          const [name, config] = group;
          if (typeof config === "object" && config.description) {
            return `${name} (${config.description})`;
          }
        }
        return String(group);
      })
      .join(", ");
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled || isLoadingModes}
        className="flex items-center gap-2 px-3 py-2 text-sm text-black bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        title={selectedModeData?.whenToUse || selectedModeData?.roleDefinition}
      >
        <span>
          {isLoadingModes
            ? "Loading..."
            : selectedModeData?.name || selectedMode}
        </span>
        {selectedModeData?.source === "custom" && (
          <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
            Custom
          </span>
        )}
        <svg
          className={`w-4 h-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {isOpen && !disabled && !isLoadingModes && (
        <>
          {/* Backdrop to close dropdown */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown menu */}
          <div className="absolute bottom-full left-0 mb-2 w-80 sm:w-96 bg-white border border-gray-300 rounded-lg shadow-lg z-20 max-h-96 overflow-y-auto">
            {availableModes.map((mode, index) => (
              <button
                key={`${mode.slug}-${mode.source || "builtin"}-${index}`}
                type="button"
                onClick={() => {
                  onModeChange(mode.slug);
                  setIsOpen(false);
                }}
                className={`w-full text-left p-3 hover:bg-gray-50 border-b border-gray-100 last:border-b-0 transition-colors ${
                  mode.slug === selectedMode
                    ? "bg-blue-50 text-blue-700"
                    : "text-gray-700"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium">{mode.name}</span>
                  {mode.source === "custom" && (
                    <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
                      Custom
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-600 mb-2 leading-relaxed">
                  {mode.whenToUse ||
                    mode.roleDefinition ||
                    "No description available"}
                </div>
                {mode.groups && mode.groups.length > 0 && (
                  <div className="text-xs text-gray-500">
                    <span className="font-medium">Permissions:</span>{" "}
                    {formatGroups(mode.groups)}
                  </div>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
