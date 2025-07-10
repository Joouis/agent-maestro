import { RooCodeSettings } from "@roo-code/types";

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
