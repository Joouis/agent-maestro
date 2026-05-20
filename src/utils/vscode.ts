import * as vscode from "vscode";

interface LanguageModelDataPartCtor {
  new (
    data: Uint8Array,
    mimeType: string,
  ): {
    data: Uint8Array;
    mimeType: string;
  };
}

/**
 * A language model response part containing arbitrary data, not an official API yet.
 */
export const LanguageModelDataPart: LanguageModelDataPartCtor | undefined = (
  vscode as any
).LanguageModelDataPart;
