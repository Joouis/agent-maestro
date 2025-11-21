import React, { useState } from "react";

interface Profile {
  id: string;
  name: string;
  apiProvider?: string;
  isActive: boolean;
}

interface ProfileSelectorProps {
  profiles: Profile[];
  isLoading: boolean;
  disabled: boolean;
}

export const ProfileSelector: React.FC<ProfileSelectorProps> = ({
  profiles,
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

  if (profiles.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-sm bg-yellow-50 border border-yellow-300 rounded-lg text-yellow-700">
        <span>No profiles</span>
      </div>
    );
  }

  // Find active profile from the list
  const activeProfile = profiles.find((p) => p.isActive);
  const profileInfo = activeProfile || {
    id: "unknown",
    name: "Not set",
    apiProvider: undefined,
    isActive: false,
  };

  // Get configuration badge color for the main button
  const getButtonStatusColor = () => {
    if (profileInfo.isActive) return "text-green-600";
    return "text-gray-400";
  };

  // Get status icon for the main button
  const getButtonStatusIcon = () => {
    if (profileInfo.isActive) return "✓";
    return "○";
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className="flex items-center gap-2 px-3 py-2 text-sm text-black bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        title={`Profile: ${profileInfo.name}${profileInfo.apiProvider ? ` (${profileInfo.apiProvider})` : ""}`}
      >
        <span className={`font-bold ${getButtonStatusColor()}`}>
          {getButtonStatusIcon()}
        </span>
        <span className="truncate max-w-[100px]">{profileInfo.name}</span>
        {profileInfo.apiProvider && (
          <span className="text-xs text-gray-500 truncate max-w-[80px]">
            {profileInfo.apiProvider}
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
                Active Profile
              </div>
              <div className="font-medium text-gray-900">
                {profileInfo.name}
              </div>
              {profileInfo.apiProvider && (
                <div className="text-xs text-gray-600">
                  Provider: {profileInfo.apiProvider}
                </div>
              )}
            </div>

            <div className="p-2">
              <div className="text-xs font-medium text-gray-500 mb-2 px-1">
                Available Profiles ({profiles.length})
              </div>
              <div className="space-y-1">
                {profiles.map((profile: Profile) => {
                  const getProfileStatusColor = () => {
                    if (profile.isActive) return "text-green-600";
                    return "text-gray-400";
                  };

                  const getProfileStatusIcon = () => {
                    if (profile.isActive) return "✓";
                    return "○";
                  };

                  return (
                    <div
                      key={profile.id}
                      className={`p-2 rounded text-sm ${
                        profile.isActive
                          ? "bg-purple-50 text-purple-700 border border-purple-200"
                          : "text-gray-600"
                      }`}
                      title={profile.apiProvider || "No provider set"}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-bold w-4 ${getProfileStatusColor()}`}
                        >
                          {getProfileStatusIcon()}
                        </span>
                        <span className="font-medium">{profile.name}</span>
                        {profile.isActive && (
                          <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
                            Active
                          </span>
                        )}
                      </div>
                      {profile.apiProvider && (
                        <div className="text-xs text-gray-500 ml-6">
                          {profile.apiProvider}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="p-3 border-t border-gray-200 bg-gray-50">
              <div className="text-xs text-gray-500">
                Configure profiles in VS Code extension settings
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
