export interface Message {
  id: string;
  content: string;
  isUser: boolean;
  timestamp: string;
  suggestions?: string[];
  isCompletionResult?: boolean;
}

export interface ChatState {
  messages: Message[];
  isWaitingForResponse: boolean;
  currentTaskId: string | null;
  showTyping: boolean;
  statusMessage: string;
  showStatus: boolean;
}

export interface ApiResponse {
  taskId?: string;
  message?: {
    ts?: number;
    type: string;
    text: string;
    partial: boolean;
    say?: string;
    ask?: string;
  };
}

export interface McpServerData {
  serverName?: string;
  toolName?: string;
  arguments?: any;
}

export interface Suggestion {
  answer: string;
}

export interface FollowupData {
  question?: string;
  suggest?: Suggestion[];
}

export type MessageEventType =
  | "task_created"
  | "task_resumed"
  | "message"
  | "task_completed"
  | "task_aborted"
  | "error";

export type MessageType = "say" | "ask";
export type AskType = "followup" | "use_mcp_server";
export type ActionType = "pressPrimaryButton" | "pressSecondaryButton";
