import { v4 as uuidv4 } from "uuid";
import type { Message } from "../types/chat";

export const getCurrentTime = (): string => {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
};

export const createMessage = (
  content: string,
  isUser: boolean,
  options: {
    suggestions?: string[];
    isCompletionResult?: boolean;
  } = {},
): Message => {
  return {
    id: uuidv4(),
    content,
    isUser,
    timestamp: getCurrentTime(),
    ...options,
  };
};

export const scrollToBottom = (element: HTMLDivElement | null): void => {
  if (element) {
    element.scrollTop = element.scrollHeight;
  }
};

export const autoResizeTextarea = (
  textarea: HTMLTextAreaElement,
  maxHeight: number = 120,
): void => {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + "px";
};

export const resetTextarea = (textarea: HTMLTextAreaElement | null): void => {
  if (textarea) {
    textarea.style.height = "auto";
  }
};

export const focusTextarea = (textarea: HTMLTextAreaElement | null): void => {
  if (textarea) {
    textarea.focus();
  }
};

export const isApprovalAction = (suggestion: string): boolean => {
  return suggestion === "Approve" || suggestion === "Reject";
};

export const formatMcpServerContent = (mcpData: any): string => {
  const serverName = mcpData.serverName || "Unknown Server";
  const toolName = mcpData.toolName || "Unknown Tool";

  let argumentsText = "";
  if (mcpData.arguments) {
    try {
      const args =
        typeof mcpData.arguments === "string"
          ? JSON.parse(mcpData.arguments)
          : mcpData.arguments;
      argumentsText = JSON.stringify(args, null, 2);
    } catch (e) {
      argumentsText = mcpData.arguments.toString();
    }
  }

  return `🔧 MCP Server Tool Request\n\nServer: ${serverName}\nTool: ${toolName}\nArguments:\n${argumentsText}\n\nDo you want to approve this MCP tool usage?`;
};

export const parseFollowupData = (
  text: string,
): { content: string; suggestions: string[] } => {
  let finalContent = text;
  let suggestions: string[] = [];

  try {
    const askData = JSON.parse(text);
    if (askData.question) {
      finalContent = askData.question;
    }
    if (askData.suggest && Array.isArray(askData.suggest)) {
      // Handle new structure where suggestions are objects with 'answer' property
      suggestions = askData.suggest.map((suggestion: any) => {
        if (typeof suggestion === "object" && suggestion.answer) {
          return suggestion.answer;
        }
        // Fallback for old format (plain strings)
        return typeof suggestion === "string" ? suggestion : String(suggestion);
      });
    }
  } catch (e) {
    console.error("Failed to parse ask data as JSON:", e);
  }

  return { content: finalContent, suggestions };
};

export const parseMcpServerData = (
  text: string,
): { content: string; suggestions: string[] } => {
  let finalContent = "";
  const suggestions: string[] = ["Approve", "Reject"];

  try {
    const mcpData = JSON.parse(text);
    finalContent = formatMcpServerContent(mcpData);
  } catch (e) {
    console.error("Failed to parse MCP server data:", e);
    finalContent =
      "🔧 MCP Server Tool Request\n\nDo you want to approve this MCP tool usage?";
  }

  return { content: finalContent, suggestions };
};
