import React, { useEffect, useState } from "react";

import { DEFAULT_API_BASE_URL, createApiEndpoints } from "../utils/constants";

interface Extension {
  isInstalled: boolean;
  isActive: boolean;
  version: string;
}

interface ExtensionInfo {
  name: string;
  version: string;
  extensions: Record<string, Extension>;
}

interface ExtensionSelectorProps {
  selectedExtension?: string;
  onExtensionChange: (extensionId: string) => void;
  disabled: boolean;
  apiBaseUrl?: string | null;
}

export const ExtensionSelector: React.FC<ExtensionSelectorProps> = ({
  selectedExtension,
  onExtensionChange,
  disabled,
  apiBaseUrl = null,
}) => {
  const [extensions, setExtensions] = useState<
    Array<{ id: string; name: string; version: string }>
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const fetchExtensions = async () => {
      try {
        setIsLoading(true);
        const endpoints = createApiEndpoints(
          apiBaseUrl || DEFAULT_API_BASE_URL,
        );
        const response = await fetch(endpoints.INFO);
        if (!response.ok) {
          throw new Error(`Failed to fetch extensions: ${response.statusText}`);
        }

        const data: ExtensionInfo = await response.json();

        // Filter extensions: skip "cline" and only include installed & active extensions
        const availableExtensions = Object.entries(data.extensions)
          .filter(
            ([id, ext]) => id !== "cline" && ext.isInstalled && ext.isActive,
          )
          .map(([id, ext]) => ({
            id,
            name: id.includes(".") ? id.split(".").pop() || id : id,
            version: ext.version,
          }));

        setExtensions(availableExtensions);

        // Set default extension logic: prefer "rooveterinaryinc.roo-cline", otherwise use first available
        if (
          !selectedExtension ||
          !availableExtensions.some((ext) => ext.id === selectedExtension)
        ) {
          if (availableExtensions.length > 0) {
            const preferredExtension = availableExtensions.find(
              (ext) => ext.id === "rooveterinaryinc.roo-cline",
            );
            const defaultExtension = preferredExtension
              ? preferredExtension.id
              : availableExtensions[0].id;
            onExtensionChange(defaultExtension);
          }
        }
      } catch (err) {
        console.error("Error fetching extensions:", err);
        setError(
          err instanceof Error ? err.message : "Failed to fetch extensions",
        );
      } finally {
        setIsLoading(false);
      }
    };

    fetchExtensions();
  }, [selectedExtension, onExtensionChange, apiBaseUrl]);

  const selectedExtensionData = extensions.find(
    (ext) => ext.id === selectedExtension,
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-sm bg-gray-100 border border-gray-300 rounded-lg opacity-50">
        <span>Loading...</span>
      </div>
    );
  }

  if (error || extensions.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-sm bg-red-50 border border-red-300 rounded-lg text-red-600">
        <span>{error || "No extensions"}</span>
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className="flex items-center gap-2 px-3 py-2 text-sm text-black bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        title={`Extension: ${selectedExtensionData?.name || selectedExtension} (v${selectedExtensionData?.version || "unknown"})`}
      >
        <span>{selectedExtensionData?.name || selectedExtension}</span>
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

      {isOpen && !disabled && (
        <>
          {/* Backdrop to close dropdown */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown menu */}
          <div className="absolute bottom-full left-0 mb-2 w-64 bg-white border border-gray-300 rounded-lg shadow-lg z-20 max-h-48 overflow-y-auto">
            {extensions.map((ext) => (
              <button
                key={ext.id}
                type="button"
                onClick={() => {
                  onExtensionChange(ext.id);
                  setIsOpen(false);
                }}
                className={`w-full text-left p-3 hover:bg-gray-50 border-b border-gray-100 last:border-b-0 transition-colors ${
                  ext.id === selectedExtension
                    ? "bg-blue-50 text-blue-700"
                    : "text-gray-700"
                }`}
              >
                <div className="font-medium mb-1">{ext.name}</div>
                <div className="text-xs text-gray-500">
                  {ext.id} (v{ext.version})
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
