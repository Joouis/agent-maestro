import { useCallback, useState } from "react";

import { DEFAULT_API_BASE_URL, createApiEndpoints } from "../utils/constants";

const REQUEST_TIMEOUT_MS = 10000;

type TaskAction =
  | "cancel"
  | "resume"
  | "pressPrimaryButton"
  | "pressSecondaryButton";

interface TaskActionResult {
  success: boolean;
  message?: string;
  error?: string;
}

interface UseTaskActionsOptions {
  apiBaseUrl?: string | null;
  extensionId?: string;
}

export const useTaskActions = (options: UseTaskActionsOptions = {}) => {
  const { apiBaseUrl = null, extensionId } = options;
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const performAction = useCallback(
    async (taskId: string, action: TaskAction): Promise<TaskActionResult> => {
      if (!extensionId) {
        return { success: false, error: "No extension selected" };
      }

      setIsLoading(true);
      setError(null);

      const baseUrl = apiBaseUrl || DEFAULT_API_BASE_URL;
      const endpoints = createApiEndpoints(baseUrl);

      const actionUrl = new URL(endpoints.TASK_ACTION(taskId));
      actionUrl.searchParams.set("extensionId", extensionId);

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          REQUEST_TIMEOUT_MS,
        );

        const response = await fetch(actionUrl.toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();
          setError(null);
          return {
            success: true,
            message: data.message || `Action ${action} completed successfully`,
          };
        } else {
          const errorData = await response.json().catch(() => ({}));
          const errorMessage =
            errorData.error || `Action failed: ${response.status}`;
          setError(errorMessage);
          return { success: false, error: errorMessage };
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Action failed";
        console.error(`Task action ${action} failed:`, err);
        setError(errorMessage);
        return { success: false, error: errorMessage };
      } finally {
        setIsLoading(false);
      }
    },
    [apiBaseUrl, extensionId],
  );

  const cancelTask = useCallback(
    async (taskId: string) => {
      return performAction(taskId, "cancel");
    },
    [performAction],
  );

  const resumeTask = useCallback(
    async (taskId: string) => {
      return performAction(taskId, "resume");
    },
    [performAction],
  );

  const pressButton = useCallback(
    async (taskId: string, buttonType: "primary" | "secondary") => {
      const action =
        buttonType === "primary"
          ? "pressPrimaryButton"
          : "pressSecondaryButton";
      return performAction(taskId, action);
    },
    [performAction],
  );

  return {
    isLoading,
    error,
    cancelTask,
    resumeTask,
    pressButton,
    performAction,
  };
};
