import {
  RooCodeSettings,
  RooCodeEventName,
  ClineMessage,
} from "@roo-code/types";

// TaskEvent-related type definitions
export interface TaskEventBasicData {
  taskId: string;
}

export interface MessageEventData extends TaskEventBasicData {
  action: "created" | "updated";
  message: ClineMessage;
}

export interface TaskCompletedEventData extends TaskEventBasicData {
  tokenUsage: any;
  toolUsage: any;
}

export interface TaskModeSwitchedEventData extends TaskEventBasicData {
  mode: string;
}

export interface TaskSpawnedEventData extends TaskEventBasicData {
  childTaskId: string;
}

export interface TaskTokenUsageUpdatedEventData extends TaskEventBasicData {
  tokenUsage: any;
}

export interface TaskToolFailedEventData extends TaskEventBasicData {
  tool: string;
  error: any;
}

// Discriminated union for TaskEvent data based on event type
export type TaskEventData<T extends RooCodeEventName = RooCodeEventName> =
  T extends RooCodeEventName.Message
    ? MessageEventData
    : T extends RooCodeEventName.TaskCreated
      ? TaskEventBasicData
      : T extends RooCodeEventName.TaskStarted
        ? TaskEventBasicData
        : T extends RooCodeEventName.TaskCompleted
          ? TaskCompletedEventData
          : T extends RooCodeEventName.TaskAborted
            ? TaskEventBasicData
            : T extends RooCodeEventName.TaskPaused
              ? TaskEventBasicData
              : T extends RooCodeEventName.TaskUnpaused
                ? TaskEventBasicData
                : T extends RooCodeEventName.TaskModeSwitched
                  ? TaskModeSwitchedEventData
                  : T extends RooCodeEventName.TaskSpawned
                    ? TaskSpawnedEventData
                    : T extends RooCodeEventName.TaskAskResponded
                      ? TaskEventBasicData
                      : T extends RooCodeEventName.TaskTokenUsageUpdated
                        ? TaskTokenUsageUpdatedEventData
                        : T extends RooCodeEventName.TaskToolFailed
                          ? TaskToolFailedEventData
                          : never;

export interface TaskEvent<T extends RooCodeEventName = RooCodeEventName> {
  name: T;
  data: TaskEventData<T>;
}

export interface MessageRequest {
  text: string;
  images?: string[];
  configuration?: RooCodeSettings;
  newTab?: boolean;
  extensionId?: string; // Optional: specify Roo variant extension like Kilo Code
}

export interface ActionRequest {
  action: "pressPrimaryButton" | "pressSecondaryButton" | "cancel" | "resume";
  extensionId?: string; // Optional: specify Roo variant extension like Kilo Code
}

export interface FileReadRequest {
  path: string;
}

export interface FileReadResponse {
  path: string;
  content: string;
  encoding: string;
  size: number;
  mimeType: string;
}

export interface FileWriteRequest {
  path: string;
  content: string;
  encoding: string;
}

export interface FileWriteResponse {
  path: string;
  size: number;
}

export interface WorkspaceUpdateRequest {
  folders: string[];
}

export interface WorkspaceUpdateResponse {
  success: boolean;
  message: string;
  workspaceFolders: Array<{
    uri: string;
    name: string;
    index: number;
  }>;
}

export interface CloseWorkspacesResponse {
  success: boolean;
  message: string;
}
