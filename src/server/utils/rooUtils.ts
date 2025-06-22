import { ClineMessage } from "@roo-code/types";
import { isEqual } from "es-toolkit";

// Helper function to check if message is complete (handles undefined partial)
export const isMessageCompleted = (message: ClineMessage): boolean => {
  return !message.partial;
};

// Check for duplicate messages when partial is false
export const areCompletedMessagesEqual = (
  message1: ClineMessage,
  message2?: ClineMessage,
): boolean => {
  if (
    isMessageCompleted(message1) &&
    message2 &&
    isMessageCompleted(message2)
  ) {
    if (isEqual(message1, message2)) {
      return true;
    }
  }

  return false;
};
