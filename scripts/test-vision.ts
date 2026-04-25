/**
 * Test script: verify image (vision) support across API routes.
 *
 * Usage:
 *   npx tsx scripts/test-vision.ts <image-path>                       # all APIs
 *   npx tsx scripts/test-vision.ts --api chat <image-path>            # chat completions only
 *   npx tsx scripts/test-vision.ts --api responses <image-path>       # responses only
 *   npx tsx scripts/test-vision.ts --api anthropic <image-path>       # anthropic messages only
 *   npx tsx scripts/test-vision.ts --api anthropic-tool-result <image-path>  # anthropic tool_result(image) shape
 *
 * Reads model and base_url from ~/.codex/config.toml when available.
 * Make sure Agent Maestro extension is running with the proxy server active.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { parse } from "smol-toml";

type ApiType = "chat" | "responses" | "anthropic" | "anthropic-tool-result";
const ALL_APIS: ApiType[] = [
  "chat",
  "responses",
  "anthropic",
  "anthropic-tool-result",
];

const DEFAULT_PORT = 23333;
const DEFAULT_MODEL = "gpt-5.1";
const PROMPT =
  "Transcribe any text in this image, then briefly describe the rest.";

function loadConfigToml(): { model: string; port: number } {
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = parse(raw) as any;
    const model = config.model ?? DEFAULT_MODEL;
    const provider = config.model_provider;
    const baseUrl: string = config.model_providers?.[provider]?.base_url ?? "";
    const portMatch = baseUrl.match(/:(\d+)/);
    const port = portMatch ? Number(portMatch[1]) : DEFAULT_PORT;
    return { model, port };
  } catch {
    return { model: DEFAULT_MODEL, port: DEFAULT_PORT };
  }
}

function parseArgs(): { apis: ApiType[]; imagePath: string } {
  const args = process.argv.slice(2);
  let api: ApiType | null = null;
  let imagePath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--api" && args[i + 1]) {
      const val = args[++i];
      if (
        val === "chat" ||
        val === "responses" ||
        val === "anthropic" ||
        val === "anthropic-tool-result"
      ) {
        api = val;
      } else {
        console.error(
          `Unknown API type: ${val}. Use chat, responses, anthropic, or anthropic-tool-result.`,
        );
        process.exit(1);
      }
    } else {
      imagePath = args[i];
    }
  }

  if (!imagePath) {
    console.error(
      "Usage: npx tsx scripts/test-vision.ts [--api chat|responses|anthropic|anthropic-tool-result] <image-path>",
    );
    process.exit(1);
  }

  return { apis: api ? [api] : ALL_APIS, imagePath };
}

function buildChatCompletionsRequest(model: string, dataUri: string) {
  return {
    url: "/api/openai/v1/chat/completions",
    body: {
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        },
      ],
    },
  };
}

function buildResponsesRequest(model: string, dataUri: string) {
  return {
    url: "/api/openai/v1/responses",
    body: {
      model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: PROMPT },
            { type: "input_image", image_url: dataUri },
          ],
        },
      ],
    },
  };
}

function buildAnthropicRequest(
  model: string,
  mimeType: string,
  base64: string,
) {
  return {
    url: "/api/anthropic/v1/messages",
    headers: { "x-api-key": "test", "anthropic-version": "2023-06-01" },
    body: {
      model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            {
              type: "image",
              source: { type: "base64", media_type: mimeType, data: base64 },
            },
          ],
        },
      ],
    },
  };
}

// Mimics what Claude Code's Read tool produces: an assistant turn calls a
// tool, then the user turn delivers the tool result containing an image block.
// Exercises the tool_result.content path in convertAnthropicMessagesToVSCode.
function buildAnthropicToolResultRequest(
  model: string,
  mimeType: string,
  base64: string,
) {
  return {
    url: "/api/anthropic/v1/messages",
    headers: { "x-api-key": "test", "anthropic-version": "2023-06-01" },
    body: {
      model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Read the attached image." }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_test_read_image",
              name: "Read",
              input: { file_path: "/tmp/test.png" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_test_read_image",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mimeType,
                    data: base64,
                  },
                },
              ],
            },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    },
  };
}

async function runApi(
  api: ApiType,
  model: string,
  baseUrl: string,
  mimeType: string,
  base64: string,
  dataUri: string,
) {
  let url: string;
  let body: unknown;
  let extraHeaders: Record<string, string> = {};

  switch (api) {
    case "chat": {
      const req = buildChatCompletionsRequest(model, dataUri);
      url = req.url;
      body = req.body;
      break;
    }
    case "responses": {
      const req = buildResponsesRequest(model, dataUri);
      url = req.url;
      body = req.body;
      break;
    }
    case "anthropic": {
      const req = buildAnthropicRequest(model, mimeType, base64);
      url = req.url;
      body = req.body;
      extraHeaders = req.headers;
      break;
    }
    case "anthropic-tool-result": {
      const req = buildAnthropicToolResultRequest(model, mimeType, base64);
      url = req.url;
      body = req.body;
      extraHeaders = req.headers;
      break;
    }
  }

  console.log(`URL:   ${baseUrl}${url}`);

  const res = await fetch(`${baseUrl}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Error ${res.status}: ${text}\n`);
    return;
  }

  const json = await res.json();
  console.log("Response:");
  console.log(JSON.stringify(json, null, 2));
  console.log();
}

async function main() {
  const { apis, imagePath } = parseArgs();
  const resolved = path.resolve(imagePath);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  const ext = path.extname(resolved).toLowerCase().replace(".", "");
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  const mimeType = mimeMap[ext] || "image/png";

  const imageData = fs.readFileSync(resolved);
  const base64 = imageData.toString("base64");
  const dataUri = `data:${mimeType};base64,${base64}`;

  const { model, port } = loadConfigToml();
  const baseUrl = `http://localhost:${port}`;

  console.log(`Image: ${resolved}`);
  console.log(`Size:  ${(imageData.length / 1024).toFixed(1)} KB`);
  console.log(`MIME:  ${mimeType}`);
  console.log(`Model: ${model}\n`);

  for (const api of apis) {
    console.log(`--- ${api} ---`);
    await runApi(api, model, baseUrl, mimeType, base64, dataUri);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
