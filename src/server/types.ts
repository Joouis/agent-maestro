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
