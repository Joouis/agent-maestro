import React, { useState } from "react";

interface Provider {
  id: string;
  name: string;
  description: string;
  isConfigured: boolean;
  isCurrent: boolean;
  configStatus?: string;
}

interface ProviderSelectorProps {
  currentProvider?: string;
  currentModel?: string;
  providers: Provider[];
  isLoading: boolean;
  disabled: boolean;
}

export const ProviderSelector: React.FC<ProviderSelectorProps> = ({
  currentProvider,
  currentModel,
  providers,
  isLoading,
  disabled,
}) => {
  const [isOpen, setIsOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-sm bg-gray-100 border border-gray-300 rounded-lg opacity-50">
        <span>Loading...</span>
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-sm bg-yellow-50 border border-yellow-300 rounded-lg text-yellow-700">
        <span>No providers</span>
      </div>
    );
  }

  // Find current provider from the list
  const currentProviderData = providers.find((p) => p.isCurrent);
  const providerInfo = currentProviderData || {
    id: "unknown",
    name: "Not set",
    description: "No provider configured",
    isConfigured: false,
    isCurrent: false,
    configStatus: "Not configured",
  };

  // Get configuration badge color for the main button
  const getButtonStatusColor = () => {
    if (providerInfo.isCurrent) return "text-green-600";
    if (providerInfo.isConfigured) return "text-blue-600";
    return "text-gray-400";
  };

  // Get status icon for the main button
  const getButtonStatusIcon = () => {
    if (providerInfo.isCurrent) return "✓";
    if (providerInfo.isConfigured) return "✓";
    return "○";
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className="flex items-center gap-2 px-3 py-2 text-sm text-black bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        title={`${providerInfo.name} - ${providerInfo.configStatus}${currentModel ? ` | Model: ${currentModel}` : ""}`}
      >
        <span className={`font-bold ${getButtonStatusColor()}`}>
          {getButtonStatusIcon()}
        </span>
        <span className="truncate max-w-[100px]">{providerInfo.name}</span>
        {providerInfo.isCurrent && currentModel && (
          <span className="text-xs text-gray-500 truncate max-w-[80px]">
            {currentModel.split("/").pop()}
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

      {isOpen && !disabled && (
        <>
          {/* Backdrop to close dropdown */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown menu */}
          <div className="absolute bottom-full left-0 mb-2 w-72 bg-white border border-gray-300 rounded-lg shadow-lg z-20 max-h-64 overflow-y-auto">
            <div className="p-3 border-b border-gray-200 bg-gray-50">
              <div className="text-xs font-medium text-gray-500 mb-1">
                Current Configuration
              </div>
              <div className="font-medium text-gray-900">
                {providerInfo.name}
              </div>
              <div className="text-xs text-gray-600">
                {providerInfo.description}
              </div>
              {providerInfo.isCurrent && currentModel && (
                <div className="text-xs text-purple-600 mt-1 truncate">
                  Model: {currentModel}
                </div>
              )}
            </div>

            <div className="p-2">
              <div className="text-xs font-medium text-gray-500 mb-2 px-1">
                Available Providers ({providers.length})
              </div>
              <div className="space-y-1">
                {providers.map((provider) => {
                  const getProviderStatusColor = () => {
                    if (provider.isCurrent) return "text-green-600";
                    if (provider.isConfigured) return "text-blue-600";
                    return "text-gray-400";
                  };

                  const getProviderStatusIcon = () => {
                    if (provider.isCurrent) return "✓";
                    if (provider.isConfigured) return "✓";
                    return "○";
                  };

                  return (
                    <div
                      key={provider.id}
                      className={`p-2 rounded text-sm ${
                        provider.isCurrent
                          ? "bg-purple-50 text-purple-700 border border-purple-200"
                          : "text-gray-600"
                      }`}
                      title={provider.configStatus}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-bold w-4 ${getProviderStatusColor()}`}
                        >
                          {getProviderStatusIcon()}
                        </span>
                        <span className="font-medium">{provider.name}</span>
                        {provider.isCurrent && (
                          <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
                            Active
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 ml-6">
                        {provider.description}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="p-3 border-t border-gray-200 bg-gray-50">
              <div className="text-xs text-gray-500">
                Configure providers in VS Code extension settings
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
