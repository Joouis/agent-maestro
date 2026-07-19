import * as vscode from "vscode";

import { logger } from "../../utils/logger";

const RESIZE_COMMAND = "_chat.resizeImage";
const SAFE_IMAGE_BYTES = 750 * 1024;

type ResizeImageCommand = (
  command: string,
  context: undefined,
  bytes: Uint8Array,
  mimeType: string,
) => Thenable<Uint8Array | undefined>;

export interface ResizedImage {
  bytes: Buffer;
  mimeType: string;
}

const normalizeBytes = (value: Uint8Array | undefined): Buffer | undefined => {
  if (!value) {
    return undefined;
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
};

/**
 * Keep image messages below the size at which Copilot's prompt renderer can
 * count the encoded payload as hundreds of thousands of tokens. VS Code's own
 * private resize command runs in the renderer, where image codecs are
 * available, and transcodes the result to JPEG.
 */
export async function resizeImageForVscodeLm(
  bytes: Buffer,
  mimeType: string,
  executeCommand: ResizeImageCommand = (command, context, data, type) =>
    vscode.commands.executeCommand<Uint8Array>(command, context, data, type),
): Promise<ResizedImage> {
  if (bytes.byteLength <= SAFE_IMAGE_BYTES) {
    return { bytes, mimeType };
  }

  try {
    // JPEG output is much smaller than the PNG that VS Code otherwise creates
    // for a large tool-result screenshot. The command scales the shorter side
    // to 768px before encoding, which also prevents a second resize later.
    const resized = normalizeBytes(
      await executeCommand(RESIZE_COMMAND, undefined, bytes, "image/jpeg"),
    );
    if (resized && resized.byteLength < bytes.byteLength) {
      return { bytes: resized, mimeType: "image/jpeg" };
    }
  } catch (error) {
    logger.warn(
      `Failed to resize ${mimeType} image for VS Code LM; keeping the original bytes`,
      error,
    );
  }

  return { bytes, mimeType };
}
