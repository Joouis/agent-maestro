import * as fs from "fs";
import { Context } from "hono";
import * as path from "path";
import * as vscode from "vscode";

import packageJson from "../../../package.json";

interface ErrorLogContext {
  requestBody: any;
  error: Error | unknown;
  endpoint: string;
  modelId?: string;
}

/**
 * Cleans a given stack of possible paths
 * @param stack The stack to sanitize
 * @param cleanupPatterns Cleanup patterns to remove from the stack
 * @returns The cleaned stack
 * @see https://github.com/microsoft/vscode/blob/main/src/vs/platform/telemetry/common/telemetryUtils.ts#L277
 */
function anonymizeFilePaths(stack: string, cleanupPatterns: RegExp[]): string {
  // Fast check to see if it is a file path to avoid doing unnecessary heavy regex work
  if (!stack || (!stack.includes("/") && !stack.includes("\\"))) {
    return stack;
  }

  let updatedStack = stack;

  const cleanUpIndexes: [number, number][] = [];
  for (const regexp of cleanupPatterns) {
    while (true) {
      const result = regexp.exec(stack);
      if (!result) {
        break;
      }
      cleanUpIndexes.push([result.index, regexp.lastIndex]);
    }
  }

  const nodeModulesRegex = /^[\\\/]?(node_modules|node_modules\.asar)[\\\/]/;
  const fileRegex =
    /(file:\/\/)?([a-zA-Z]:(\\\\|\\|\/)|(\\\\|\\|\/))?([\w-\._]+(\\\\|\\|\/))+[\w-\._]*/g;
  let lastIndex = 0;
  updatedStack = "";

  while (true) {
    const result = fileRegex.exec(stack);
    if (!result) {
      break;
    }

    // Check to see if the any cleanupIndexes partially overlap with this match
    const overlappingRange = cleanUpIndexes.some(
      ([start, end]) => result.index < end && start < fileRegex.lastIndex,
    );

    // anoynimize user file paths that do not need to be retained or cleaned up.
    if (!nodeModulesRegex.test(result[0]) && !overlappingRange) {
      updatedStack +=
        stack.substring(lastIndex, result.index) + "<REDACTED: user-file-path>";
      lastIndex = fileRegex.lastIndex;
    }
  }
  if (lastIndex < stack.length) {
    updatedStack += stack.substr(lastIndex);
  }

  return updatedStack;
}

/**
 * Attempts to remove commonly leaked PII
 * @param property The property which will be removed if it contains user data
 * @returns The new value for the property
 * @see https://github.com/microsoft/vscode/blob/main/src/vs/platform/telemetry/common/telemetryUtils.ts#L329
 */
function removePropertiesWithPossibleUserInfo(property: string): string {
  // If for some reason it is undefined we skip it (this shouldn't be possible);
  if (!property) {
    return property;
  }

  const userDataRegexes = [
    { label: "URL", regex: /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]*/ },
    { label: "Google API Key", regex: /AIza[A-Za-z0-9_\\\-]{35}/ },
    {
      label: "JWT",
      regex:
        /eyJ[0eXAiOiJKV1Qi|hbGci|a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+/,
    },
    { label: "Slack Token", regex: /xox[pbar]\-[A-Za-z0-9]/ },
    {
      label: "GitHub Token",
      regex:
        /(gh[psuro]_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59})/,
    },
    {
      label: "Generic Secret",
      regex:
        /(key|token|sig|secret|signature|password|passwd|pwd|android:value)[^a-zA-Z0-9]/i,
    },
    {
      label: "CLI Credentials",
      regex:
        /((login|psexec|(certutil|psexec)\.exe).{1,50}(\s-u(ser(name)?)?\s+.{3,100})?\s-(admin|user|vm|root)?p(ass(word)?)?\s+["']?[^$\-\/\s]|(^|[\s\r\n\\])net(\.exe)?.{1,5}(user\s+|share\s+\/user:| user -? secrets ? set) \s + [^ $\s \/])/,
    },
    {
      label: "Microsoft Entra ID",
      regex: /eyJ(?:0eXAiOiJKV1Qi|hbGci|[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\.)/,
    },
    { label: "Email", regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
  ];

  // Check for common user data in the telemetry events
  for (const secretRegex of userDataRegexes) {
    if (secretRegex.regex.test(property)) {
      return `<REDACTED: ${secretRegex.label}>`;
    }
  }

  return property;
}

/**
 * Sanitizes request body by removing sensitive fields and user info
 */
function sanitizeRequestBody(body: any): any {
  if (!body || typeof body !== "object") {
    return body;
  }

  const sensitiveFields = [
    "api_key",
    "apiKey",
    "authorization",
    "token",
    "password",
    "secret",
  ];

  // Deep clone and sanitize
  const sanitized = JSON.parse(JSON.stringify(body));

  // Recursive function to sanitize nested objects and arrays
  function sanitizeValue(value: any): any {
    if (typeof value === "string") {
      // First anonymize file paths
      let sanitizedValue = anonymizeFilePaths(value, []);
      // Then remove properties with possible user info
      sanitizedValue = removePropertiesWithPossibleUserInfo(sanitizedValue);
      return sanitizedValue;
    } else if (Array.isArray(value)) {
      return value.map(sanitizeValue);
    } else if (value && typeof value === "object") {
      const sanitizedObj: any = {};
      for (const key in value) {
        // Check if key is sensitive field
        if (sensitiveFields.includes(key)) {
          sanitizedObj[key] = "[REDACTED]";
        } else {
          sanitizedObj[key] = sanitizeValue(value[key]);
        }
      }
      return sanitizedObj;
    }
    return value;
  }

  // Remove sensitive fields at root level
  for (const field of sensitiveFields) {
    if (field in sanitized) {
      sanitized[field] = "[REDACTED]";
    }
  }

  // Sanitize headers if present
  if (sanitized.headers && typeof sanitized.headers === "object") {
    for (const field of sensitiveFields) {
      if (field in sanitized.headers) {
        sanitized.headers[field] = "[REDACTED]";
      }
    }
    // Sanitize all header values
    for (const key in sanitized.headers) {
      sanitized.headers[key] = sanitizeValue(sanitized.headers[key]);
    }
  }

  // Sanitize all other fields recursively
  for (const key in sanitized) {
    if (key !== "headers" && !sensitiveFields.includes(key)) {
      sanitized[key] = sanitizeValue(sanitized[key]);
    }
  }

  return sanitized;
}

/**
 * Generates a timestamped log filename
 */
function generateLogFilename(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const milliseconds = String(now.getMilliseconds()).padStart(3, "0");

  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}-${milliseconds}-debug.log`;
}

/**
 * Gets extension metadata for logging
 */
function getExtensionMetadata() {
  return {
    name: packageJson.name,
    displayName: packageJson.displayName,
    version: packageJson.version,
    vscodeVersion: vscode.version,
  };
}

/**
 * Logs error details to a timestamped file in the current working directory
 * @returns The absolute path to the log file
 */
export async function logErrorToFile(
  context: ErrorLogContext,
): Promise<string> {
  const filename = generateLogFilename();
  const cwd = process.cwd();
  const logPath = path.join(cwd, filename);

  const errorMessage =
    context.error instanceof Error
      ? context.error.message
      : String(context.error);
  const errorStack =
    context.error instanceof Error ? context.error.stack : undefined;

  const logData = {
    timestamp: new Date().toISOString(),
    endpoint: context.endpoint,
    extension: getExtensionMetadata(),
    modelId: context.modelId,
    error: {
      message: errorMessage,
      stack: errorStack,
      raw: context.error,
    },
    requestBody: sanitizeRequestBody(context.requestBody),
  };

  const logContent = JSON.stringify(logData, null, 2);

  try {
    await fs.promises.writeFile(logPath, logContent, "utf8");
    return logPath;
  } catch (writeError) {
    // If we can't write the log file, at least log to console
    console.error("Failed to write error log file:", writeError);
    console.error("Original error context:", logData);
    throw writeError;
  }
}

/**
 * Common error handler that logs error details to file
 * @param c - Hono context object
 * @param error - The error that occurred
 * @param endpoint - The API endpoint where the error occurred
 * @param modelId - Optional model ID being used
 * @returns The log file path, or undefined if logging failed
 */
export async function handleErrorWithLogging(
  c: Context,
  error: unknown,
  endpoint: string,
  modelId?: string,
): Promise<string | undefined> {
  // Get request body for error logging
  let requestBody;
  try {
    requestBody = await c.req.json();
  } catch {
    requestBody = null;
  }

  // Log error details to file
  try {
    return await logErrorToFile({
      requestBody,
      error,
      endpoint,
      modelId,
    });
  } catch (logError) {
    console.error("Failed to write error log file:", logError);
    return undefined;
  }
}
