// Check if isDev query parameter exists to determine port
const getPort = () => {
  if (typeof window !== "undefined") {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.has("isDev") ? 33333 : 23333;
  }
  return 23333;
};

const PORT = getPort();
export const DEFAULT_API_BASE_URL = `http://localhost:${PORT}`;

// Dynamic API endpoint factory - uses stored URL or falls back to default
export const createApiEndpoints = (baseUrl: string = DEFAULT_API_BASE_URL) => {
  const cleanUrl = baseUrl.replace(/\/+$/, "");
  const rooApiBase = `${cleanUrl}/api/v1/roo`;
  const infoApiBase = `${cleanUrl}/api/v1`;

  return {
    TASK: `${rooApiBase}/task`,
    TASK_MESSAGE: (taskId: string) => `${rooApiBase}/task/${taskId}/message`,
    TASK_ACTION: (taskId: string) => `${rooApiBase}/task/${taskId}/action`,
    INFO: `${infoApiBase}/info`,
  };
};

export const SUGGESTION_ACTIONS = {
  APPROVE: "Approve",
  REJECT: "Reject",
} as const;

export const ACTION_TYPES = {
  APPROVE: "pressPrimaryButton",
  REJECT: "pressSecondaryButton",
} as const;

export const STATUS_MESSAGES = {
  CONNECTING: "Connecting to RooCode...",
  RECEIVING: "Receiving response...",
  TASK_CREATED: "Task created, streaming response...",
  TASK_RESUMED: "Task resumed, streaming response...",
  TASK_COMPLETED: "Task completed!",
  TASK_ERROR: "Task ended with error",
  APPROVING: "Approving request...",
  REJECTING: "Rejecting request...",
  APPROVED: "Request approved!",
  REJECTED: "Request rejected!",
  ERROR_PROCESSING: "Error processing request",
  FINALIZING: "Response completed! Finalizing...",
} as const;

export const MESSAGE_TYPES = {
  SAY: "say",
  ASK: "ask",
} as const;

export const ASK_TYPES = {
  FOLLOWUP: "followup",
  USE_MCP_SERVER: "use_mcp_server",
} as const;

export enum RooCodeEventName {
  Message = "message",
  TaskCreated = "taskCreated",
  TaskStarted = "taskStarted",
  TaskModeSwitched = "taskModeSwitched",
  TaskPaused = "taskPaused",
  TaskUnpaused = "taskUnpaused",
  TaskAskResponded = "taskAskResponded",
  TaskAborted = "taskAborted",
  TaskSpawned = "taskSpawned",
  TaskCompleted = "taskCompleted",
  TaskTokenUsageUpdated = "taskTokenUsageUpdated",
  TaskToolFailed = "taskToolFailed",
  EvalPass = "evalPass",
  EvalFail = "evalFail",
}

export const UI_CONFIG = {
  STATUS_DISPLAY_DURATION: 3000,
  TASK_COMPLETION_DELAY: 3000,
  TEXTAREA_MAX_HEIGHT: 120,
  MESSAGE_UPDATE_DELAY: 1,
} as const;

export const MODES = [
  {
    slug: "code",
    name: "💻 Code",
    whenToUse:
      "Use this mode when you need to write, modify, or refactor code. Ideal for implementing features, fixing bugs, creating new files, or making code improvements across any programming language or framework.",
    groups: ["read", "edit", "browser", "command", "mcp"],
  },
  {
    slug: "architect",
    name: "🏗️ Architect",
    whenToUse:
      "Use this mode when you need to plan, design, or strategize before implementation. Perfect for breaking down complex problems, creating technical specifications, designing system architecture, or brainstorming solutions before coding.",
    groups: [
      "read",
      ["edit", { fileRegex: "\\.md$", description: "Markdown files only" }],
      "browser",
      "mcp",
    ],
  },
  {
    slug: "ask",
    name: "❓ Ask",
    whenToUse:
      "Use this mode when you need explanations, documentation, or answers to technical questions. Best for understanding concepts, analyzing existing code, getting recommendations, or learning about technologies without making changes.",
    groups: ["read", "browser", "mcp"],
  },
  {
    slug: "debug",
    name: "🪲 Debug",
    whenToUse:
      "Use this mode when you're troubleshooting issues, investigating errors, or diagnosing problems. Specialized in systematic debugging, adding logging, analyzing stack traces, and identifying root causes before applying fixes.",
    groups: ["read", "edit", "browser", "command", "mcp"],
  },
  {
    slug: "orchestrator",
    name: "🪃 Orchestrator",
    whenToUse:
      "Use this mode for complex, multi-step projects that require coordination across different specialties. Ideal when you need to break down large tasks into subtasks, manage workflows, or coordinate work that spans multiple domains or expertise areas.",
    groups: [],
  },
] as const;

export const DEFAULT_MODE = "ask";
