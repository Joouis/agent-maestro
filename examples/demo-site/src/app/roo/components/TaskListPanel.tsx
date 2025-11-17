import React, { useState } from "react";

import type { HistoryItem } from "../hooks/useTaskHistory";

interface TaskListPanelProps {
  tasks: HistoryItem[];
  currentTaskId: string | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  onSelectTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
  onResumeTask: (taskId: string) => void;
  disabled?: boolean;
  totalTaskCount?: number; // Total tasks across all workspaces
  currentWorkspace?: string; // Current workspace path for display
}

export const TaskListPanel: React.FC<TaskListPanelProps> = ({
  tasks,
  currentTaskId,
  isLoading,
  error,
  onRefresh,
  onSelectTask,
  onCancelTask,
  onResumeTask,
  disabled = false,
  totalTaskCount,
  currentWorkspace,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const isFiltered =
    currentWorkspace && totalTaskCount && tasks.length < totalTaskCount;

  const formatTimestamp = (ts: number) => {
    const date = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const formatCost = (cost: number) => {
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
  };

  const formatTokens = (tokensIn: number, tokensOut: number) => {
    const total = tokensIn + tokensOut;
    if (total > 1000000) return `${(total / 1000000).toFixed(1)}M`;
    if (total > 1000) return `${(total / 1000).toFixed(1)}k`;
    return total.toString();
  };

  const truncateTask = (task: string, maxLength: number = 60) => {
    if (task.length <= maxLength) return task;
    return task.substring(0, maxLength) + "...";
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className="flex items-center gap-2 px-3 py-2 text-sm text-black bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        title={`Task History (${tasks.length} tasks)`}
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span>Tasks</span>
        <span className="text-xs bg-gray-200 px-1.5 py-0.5 rounded-full">
          {tasks.length}
        </span>
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
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />

          <div className="absolute bottom-full left-0 mb-2 w-96 bg-white border border-gray-300 rounded-lg shadow-lg z-20 max-h-96 overflow-hidden flex flex-col">
            <div className="p-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-gray-900">
                  Task History
                </div>
                <div className="text-xs text-gray-500">
                  {isFiltered ? (
                    <>
                      {tasks.length} of {totalTaskCount} task
                      {totalTaskCount !== 1 ? "s" : ""}{" "}
                      <span className="text-blue-600">(current workspace)</span>
                    </>
                  ) : (
                    <>
                      {tasks.length} task{tasks.length !== 1 ? "s" : ""} in
                      history
                    </>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={onRefresh}
                disabled={isLoading}
                className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded transition-colors disabled:opacity-50"
                title="Refresh task list"
              >
                <svg
                  className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
              </button>
            </div>

            {error && (
              <div className="p-3 bg-red-50 text-red-700 text-xs">{error}</div>
            )}

            <div className="flex-1 overflow-y-auto">
              {isLoading && tasks.length === 0 ? (
                <div className="p-4 text-center text-gray-500 text-sm">
                  Loading tasks...
                </div>
              ) : tasks.length === 0 ? (
                <div className="p-4 text-center text-gray-500 text-sm">
                  No tasks in history
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {tasks.map((task) => {
                    const isCurrentTask = task.id === currentTaskId;
                    return (
                      <div
                        key={task.id}
                        className={`p-3 hover:bg-gray-50 transition-colors ${
                          isCurrentTask
                            ? "bg-blue-50 border-l-4 border-blue-500"
                            : ""
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-mono text-gray-400">
                                #{task.number}
                              </span>
                              {isCurrentTask && (
                                <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                                  Current
                                </span>
                              )}
                            </div>
                            <div
                              className="text-sm text-gray-900 mt-1 line-clamp-2 cursor-pointer hover:text-blue-600"
                              onClick={() => onSelectTask(task.id)}
                              title={task.task}
                            >
                              {truncateTask(task.task)}
                            </div>
                            <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                              <span title="Time">
                                {formatTimestamp(task.ts)}
                              </span>
                              <span
                                title={`Tokens: ${task.tokensIn} in, ${task.tokensOut} out`}
                              >
                                {formatTokens(task.tokensIn, task.tokensOut)}{" "}
                                tokens
                              </span>
                              <span title="Total cost">
                                {formatCost(task.totalCost)}
                              </span>
                            </div>
                          </div>
                          <div className="flex flex-col gap-1">
                            {isCurrentTask ? (
                              <button
                                type="button"
                                onClick={() => onCancelTask(task.id)}
                                className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
                                title="Cancel current task"
                              >
                                Cancel
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => onResumeTask(task.id)}
                                className="px-2 py-1 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200 transition-colors"
                                title="Resume this task"
                              >
                                Resume
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="p-3 border-t border-gray-200 bg-gray-50">
              <div className="text-xs text-gray-500">
                Click on a task to view details, or use Resume/Cancel to manage
                tasks
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
