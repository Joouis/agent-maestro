import { useCallback } from "react";
import {
  API_ENDPOINTS,
  ACTION_TYPES,
  SUGGESTION_ACTIONS,
} from "../utils/constants";
import type { ActionType } from "../types/chat";

export const useApiClient = () => {
  const sendTaskAction = useCallback(
    async (taskId: string, suggestion: string): Promise<boolean> => {
      const action: ActionType =
        suggestion === SUGGESTION_ACTIONS.APPROVE
          ? ACTION_TYPES.APPROVE
          : ACTION_TYPES.REJECT;

      try {
        const response = await fetch(API_ENDPOINTS.TASK_ACTION(taskId), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action }),
        });

        return response.ok;
      } catch (error) {
        console.error("Error handling approve/reject:", error);
        return false;
      }
    },
    [],
  );

  const sendMessage = useCallback(
    async (
      message: string,
      mode: string,
      extensionId: string,
      taskId?: string,
    ): Promise<Response> => {
      const url = taskId
        ? API_ENDPOINTS.TASK_MESSAGE(taskId)
        : API_ENDPOINTS.TASK;

      const body = { text: message, configuration: { mode }, extensionId };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    },
    [],
  );

  const createSSEReader = useCallback((response: Response) => {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    return {
      async read() {
        const { done, value } = await reader.read();
        if (done) return { done: true, events: [] };

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        const events: Array<{ event: string; data: any }> = [];
        let currentEvent = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.substring(7).trim();
          } else if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.substring(6));
              events.push({ event: currentEvent, data });
            } catch (e) {
              console.error("Error parsing SSE data:", e);
            }
          }
        }

        return { done: false, events };
      },
    };
  }, []);

  return {
    sendTaskAction,
    sendMessage,
    createSSEReader,
  };
};
