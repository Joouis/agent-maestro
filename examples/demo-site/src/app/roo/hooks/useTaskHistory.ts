import { useCallback, useEffect, useState } from "react";

import { DEFAULT_API_BASE_URL, createApiEndpoints } from "../utils/constants";

const REQUEST_TIMEOUT_MS = 10000;

export interface HistoryItem {
  id: string;
  number: number;
  ts: number;
  task: string;
  tokensIn: number;
  tokensOut: number;
  cacheWrites: number;
  cacheReads: number;
  totalCost: number;
  size?: number;
  workspace?: string;
}

export interface MessageItem {
  type: "say" | "ask";
  say?: string;
  ask?: string;
  text?: string;
  reasoning?: string;
  images?: string[];
  ts: number;
}

export interface TaskDetail {
  historyItem: HistoryItem;
  taskDirPath: string;
  messages?: MessageItem[];
  uiMessagesFilePath: string;
}

interface UseTaskHistoryOptions {
  apiBaseUrl?: string | null;
  extensionId?: string;
  autoFetch?: boolean;
  filterByWorkspace?: string; // Optional workspace path to filter tasks
}

export const useTaskHistory = (options: UseTaskHistoryOptions = {}) => {
  const {
    apiBaseUrl = null,
    extensionId,
    autoFetch = true,
    filterByWorkspace,
  } = options;
  const [tasks, setTasks] = useState<HistoryItem[]>([]);
  const [allTasks, setAllTasks] = useState<HistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTaskHistory = useCallback(async () => {
    if (!extensionId) {
      setError("No extension selected");
      setTasks([]);
      setAllTasks([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    const baseUrl = apiBaseUrl || DEFAULT_API_BASE_URL;
    const endpoints = createApiEndpoints(baseUrl);

    const tasksUrl = new URL(endpoints.TASKS);
    tasksUrl.searchParams.set("extensionId", extensionId);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      const response = await fetch(tasksUrl.toString(), {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        // Handle both { data: [...] } and direct array response
        const taskArray = Array.isArray(data) ? data : data.data;
        if (Array.isArray(taskArray)) {
          // Sort by timestamp descending (most recent first)
          const sortedTasks = taskArray.sort(
            (a: HistoryItem, b: HistoryItem) => b.ts - a.ts,
          );
          setAllTasks(sortedTasks);

          // Filter by workspace if specified
          const filteredTasks = filterByWorkspace
            ? sortedTasks.filter((task) => task.workspace === filterByWorkspace)
            : sortedTasks;
          setTasks(filteredTasks);
          setError(null);
        } else {
          throw new Error("Invalid API response format");
        }
      } else {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} - ${errorText}`);
      }
    } catch (err) {
      console.error("Failed to fetch task history:", err);
      setError(
        err instanceof Error ? err.message : "Failed to fetch task history",
      );
      setTasks([]);
      setAllTasks([]);
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl, extensionId, filterByWorkspace]);

  // Clear error when extension is selected
  useEffect(() => {
    if (extensionId && error === "No extension selected") {
      setError(null);
    }
  }, [extensionId, error]);

  useEffect(() => {
    if (autoFetch && extensionId) {
      fetchTaskHistory();
    }
  }, [fetchTaskHistory, autoFetch, extensionId]);

  const fetchTaskDetail = useCallback(
    async (taskId: string): Promise<TaskDetail | null> => {
      if (!extensionId) {
        return null;
      }

      const baseUrl = apiBaseUrl || DEFAULT_API_BASE_URL;
      const endpoints = createApiEndpoints(baseUrl);

      const detailUrl = new URL(endpoints.TASK_DETAIL(taskId));
      detailUrl.searchParams.set("extensionId", extensionId);

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          REQUEST_TIMEOUT_MS,
        );

        const response = await fetch(detailUrl.toString(), {
          method: "GET",
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();

          // Fetch the messages from the uiMessagesFilePath using FS_READ API
          if (data.uiMessagesFilePath) {
            try {
              const fsReadUrl = new URL(endpoints.FS_READ);
              fsReadUrl.searchParams.set("extensionId", extensionId);

              const messagesFileResp = await fetch(fsReadUrl.toString(), {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ path: data.uiMessagesFilePath }),
              });

              if (messagesFileResp.ok) {
                const messagesFile = await messagesFileResp.json();
                data.messages = JSON.parse(
                  messagesFile.content,
                ) as MessageItem[];
              }
            } catch (err) {
              console.error("Failed to fetch messages file:", err);
            }
          }

          return data as TaskDetail;
        } else {
          console.error(
            `Failed to fetch task detail: ${response.status} ${response.statusText}`,
          );
          return null;
        }
      } catch (err) {
        console.error("Failed to fetch task detail:", err);
        return null;
      }
    },
    [apiBaseUrl, extensionId],
  );

  return {
    tasks,
    allTasks,
    totalTaskCount: allTasks.length,
    isLoading,
    error,
    refetch: fetchTaskHistory,
    fetchTaskDetail,
  };
};
