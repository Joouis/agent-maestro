import * as fs from "fs";
import { dirname } from "path";
import * as vscode from "vscode";

import {
  HttpAuthentication,
  validateApiKey,
} from "../server/httpAuthentication";

export const PLACEHOLDER_API_KEY = "Powered by Agent Maestro";

export async function getClientApiKey(
  authentication: HttpAuthentication,
  client: string,
  destination: string,
): Promise<string | undefined> {
  const status = await authentication.getStatus();
  if (status === "unavailable") {
    throw new Error(
      "Run Agent Maestro: Set API Key to configure or recover HTTP authentication, then run this configurator again.",
    );
  }
  if (status === "disabled") {
    return PLACEHOLDER_API_KEY;
  }

  const validate = async (key: string): Promise<string | undefined> => {
    const invalid = validateApiKey(key);
    if (invalid) {
      return invalid;
    }
    const result = await authentication.authorize(key);
    if (result === "unavailable" || result === "busy") {
      return "Authentication is unavailable or busy. Recover access or retry.";
    }
    if (result !== "allowed") {
      return "This key does not match the Agent Maestro API key.";
    }
    return undefined;
  };
  const key = await vscode.window.showInputBox({
    title: `${client}: Agent Maestro API Key`,
    prompt: `Enter the current API key. It will be verified and saved as a credential in ${destination}. Keep this file private.`,
    password: true,
    ignoreFocusOut: true,
    validateInput: validate,
  });
  if (key === undefined) {
    return undefined;
  }
  // Recheck on submission; input validation can complete before a policy change.
  const invalid = await validate(key);
  if (invalid) {
    throw new Error(invalid);
  }
  return key;
}

export function writePrivateClientFile(
  filePath: string,
  content: string,
): void {
  fs.mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && fs.existsSync(filePath)) {
    fs.chmodSync(filePath, 0o600);
  }
  fs.writeFileSync(filePath, content, { mode: 0o600 });
}

export function configureCodexAuthentication(
  existing: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const provider = { ...existing };
  // Remove competing credential sources only from the AM provider.
  for (const property of [
    "env_key",
    "env_key_instructions",
    "experimental_bearer_token",
    "auth",
  ]) {
    delete provider[property];
  }
  provider.requires_openai_auth = false;
  const cleanHeaders = (value: unknown): Record<string, string> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value).filter(
        ([name, entry]) =>
          name.toLowerCase() !== "authorization" && typeof entry === "string",
      ),
    );
  };
  provider.http_headers = {
    ...cleanHeaders(provider.http_headers),
    Authorization: `Bearer ${key}`,
  };
  provider.env_http_headers = cleanHeaders(provider.env_http_headers);
  return provider;
}

export function quoteGeminiApiKey(key: string): string {
  // dotenv leaves backslashes literal inside single/backtick quotes; JSON escaping is not equivalent.
  for (const quote of ["'", "`", '"']) {
    if (
      !key.includes(quote) &&
      (quote !== '"' || (!key.includes("\\n") && !key.includes("\\r")))
    ) {
      return quote + key + quote;
    }
  }
  throw new Error(
    "This key cannot be represented losslessly in a Gemini .env file. Set a key without mixed quote characters and retry.",
  );
}
