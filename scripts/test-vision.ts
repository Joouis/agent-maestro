/**
 * Test script: verify image (vision) support across API routes.
 *
 * Usage:
 *   node --experimental-strip-types scripts/test-vision.ts <image-path>
 *   node --experimental-strip-types scripts/test-vision.ts --all-image-types
 *   node --experimental-strip-types scripts/test-vision.ts --all-image-types --verbose
 *   node --experimental-strip-types scripts/test-vision.ts --api chat <image-path>
 *   node --experimental-strip-types scripts/test-vision.ts --api responses <image-path>
 *   node --experimental-strip-types scripts/test-vision.ts --api anthropic <image-path>
 *   node --experimental-strip-types scripts/test-vision.ts --api anthropic-tool-result <image-path>
 *
 * --all-image-types runs PNG/JPEG/GIF/WebP in small pass-through and large
 * resize/re-encode shapes across the selected API routes.
 * Reads OpenAI model and base_url from ~/.codex/config.toml when available.
 * Anthropic routes default to claude-opus-4.8 so provider-side MIME sniffing
 * validates Anthropic request shapes. Override with AGENT_MAESTRO_MODEL,
 * AGENT_MAESTRO_OPENAI_MODEL, or AGENT_MAESTRO_ANTHROPIC_MODEL.
 * Make sure Agent Maestro extension is running with the proxy server active.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { parse } from "smol-toml";

import { WEBP_1024x935_BASE64 } from "../src/test/utils/imageMime.fixtures.ts";

type ApiType = "chat" | "responses" | "anthropic" | "anthropic-tool-result";
const ALL_APIS: ApiType[] = [
  "chat",
  "responses",
  "anthropic",
  "anthropic-tool-result",
];

const DEFAULT_PORT = 23333;
const DEFAULT_OPENAI_MODEL = "gpt-5.5";
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4.8";
const PROMPT =
  "Transcribe any text in this image, then briefly describe the rest.";
const SMALL_IMAGE_SIZE = 512;
const LARGE_IMAGE_SIZE = 1024;
const WEBP_1x1_BASE64 =
  "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";

type ImageCase = {
  path: string;
  mimeType: string;
  label: string;
};

type SmokeConfig = {
  openaiModel: string;
  anthropicModel: string;
  baseUrl: string;
};

function loadConfigToml(): SmokeConfig {
  const envModel = process.env.AGENT_MAESTRO_MODEL;
  const envOpenaiModel = process.env.AGENT_MAESTRO_OPENAI_MODEL;
  const envAnthropicModel = process.env.AGENT_MAESTRO_ANTHROPIC_MODEL;
  const envBaseUrl = process.env.AGENT_MAESTRO_BASE_URL;
  if (envModel || envOpenaiModel || envAnthropicModel || envBaseUrl) {
    return {
      openaiModel: envOpenaiModel ?? envModel ?? DEFAULT_OPENAI_MODEL,
      anthropicModel: envAnthropicModel ?? envModel ?? DEFAULT_ANTHROPIC_MODEL,
      baseUrl: envBaseUrl ?? `http://localhost:${DEFAULT_PORT}`,
    };
  }

  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = parse(raw) as any;
    const openaiModel = config.model ?? DEFAULT_OPENAI_MODEL;
    const provider = config.model_provider;
    const baseUrl: string = config.model_providers?.[provider]?.base_url ?? "";
    const portMatch = baseUrl.match(/:(\d+)/);
    return {
      openaiModel,
      anthropicModel: DEFAULT_ANTHROPIC_MODEL,
      baseUrl: baseUrl
        ? portMatch
          ? `http://localhost:${portMatch[1]}`
          : baseUrl
        : `http://localhost:${DEFAULT_PORT}`,
    };
  } catch {
    return {
      openaiModel: DEFAULT_OPENAI_MODEL,
      anthropicModel: DEFAULT_ANTHROPIC_MODEL,
      baseUrl: `http://localhost:${DEFAULT_PORT}`,
    };
  }
}

function modelForApi(api: ApiType, config: SmokeConfig): string {
  return api === "anthropic" || api === "anthropic-tool-result"
    ? config.anthropicModel
    : config.openaiModel;
}

function parseArgs(): {
  apis: ApiType[];
  imagePath?: string;
  allImageTypes: boolean;
  verbose: boolean;
} {
  const args = process.argv.slice(2);
  let api: ApiType | null = null;
  let imagePath = "";
  let allImageTypes = false;
  let verbose = false;

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
    } else if (args[i] === "--all-image-types") {
      allImageTypes = true;
    } else if (args[i] === "--verbose") {
      verbose = true;
    } else {
      imagePath = args[i];
    }
  }

  if (!allImageTypes && !imagePath) {
    console.error(
      "Usage: node --experimental-strip-types scripts/test-vision.ts [--api chat|responses|anthropic|anthropic-tool-result] [--all-image-types|<image-path>]",
    );
    process.exit(1);
  }

  return { apis: api ? [api] : ALL_APIS, imagePath, allImageTypes, verbose };
}

function mimeTypeForPath(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase().replace(".", "");
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  return mimeMap[ext] || "image/png";
}

function ensureSipsAvailable() {
  try {
    execFileSync("sips", ["--help"], { stdio: "ignore" });
  } catch {
    console.error(
      "--all-image-types requires macOS sips to generate temporary PNG/JPEG/GIF fixtures.",
    );
    process.exit(1);
  }
}

function generateImageCases(): ImageCase[] {
  ensureSipsAvailable();

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-maestro-vision-"),
  );
  const source = path.resolve("assets/icons/icon.png");
  if (!fs.existsSync(source)) {
    console.error(`Source fixture not found: ${source}`);
    process.exit(1);
  }

  const cases = [
    { label: "PNG", format: "png", extension: "png", mimeType: "image/png" },
    { label: "JPEG", format: "jpeg", extension: "jpg", mimeType: "image/jpeg" },
    { label: "GIF", format: "gif", extension: "gif", mimeType: "image/gif" },
  ];

  const generated = cases.flatMap((imageCase) =>
    [
      { label: "small", size: SMALL_IMAGE_SIZE },
      { label: "large", size: LARGE_IMAGE_SIZE },
    ].map((sizeCase) => {
      const output = path.join(
        tempDir,
        `${sizeCase.label}.${imageCase.extension}`,
      );
      execFileSync("sips", [
        "-s",
        "format",
        imageCase.format,
        "-z",
        String(sizeCase.size),
        String(sizeCase.size),
        source,
        "--out",
        output,
      ]);
      return {
        path: output,
        mimeType: imageCase.mimeType,
        label: `${imageCase.label} ${sizeCase.label} (${sizeCase.size}x${sizeCase.size})`,
      };
    }),
  );

  const smallWebpPath = path.join(tempDir, "small.webp");
  fs.writeFileSync(smallWebpPath, Buffer.from(WEBP_1x1_BASE64, "base64"));
  generated.push({
    path: smallWebpPath,
    mimeType: "image/webp",
    label: "WebP small (1x1)",
  });

  const webpPath = path.join(tempDir, "large.webp");
  fs.writeFileSync(webpPath, Buffer.from(WEBP_1024x935_BASE64, "base64"));
  generated.push({
    path: webpPath,
    mimeType: "image/webp",
    label: "WebP large (1024x935)",
  });

  return generated;
}

function buildChatCompletionsRequest(model: string, dataUri: string) {
  return {
    url: "/api/openai/v1/chat/completions",
    body: {
      model,
      max_tokens: 512,
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
      max_output_tokens: 512,
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
      max_tokens: 512,
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
      max_tokens: 512,
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
  verbose: boolean,
): Promise<boolean> {
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
    return false;
  }

  const json = await res.json();
  if (verbose) {
    console.log("Response:");
    console.log(JSON.stringify(json, null, 2));
  } else {
    const preview = JSON.stringify(json).slice(0, 180);
    console.log(
      `OK ${res.status}: ${preview}${preview.length === 180 ? "..." : ""}`,
    );
  }
  console.log();
  return true;
}

async function main() {
  const { apis, imagePath, allImageTypes, verbose } = parseArgs();
  const imageCases = allImageTypes
    ? generateImageCases()
    : [
        (() => {
          const resolved = path.resolve(imagePath!);
          if (!fs.existsSync(resolved)) {
            console.error(`File not found: ${resolved}`);
            process.exit(1);
          }
          return {
            path: resolved,
            mimeType: mimeTypeForPath(resolved),
            label: path.basename(resolved),
          };
        })(),
      ];

  const config = loadConfigToml();
  let failures = 0;

  console.log(`OpenAI model:    ${config.openaiModel}`);
  console.log(`Anthropic model: ${config.anthropicModel}`);
  console.log(`Base:            ${config.baseUrl}\n`);

  for (const imageCase of imageCases) {
    const imageData = fs.readFileSync(imageCase.path);
    const base64 = imageData.toString("base64");
    const dataUri = `data:${imageCase.mimeType};base64,${base64}`;

    console.log(`Image: ${imageCase.path}`);
    console.log(`Case:  ${imageCase.label}`);
    console.log(`Size:  ${(imageData.length / 1024).toFixed(1)} KB`);
    console.log(`MIME:  ${imageCase.mimeType}\n`);

    for (const api of apis) {
      console.log(`--- ${api} ---`);
      const model = modelForApi(api, config);
      console.log(`Model: ${model}`);
      const ok = await runApi(
        api,
        model,
        config.baseUrl,
        imageCase.mimeType,
        base64,
        dataUri,
        verbose,
      );
      if (!ok) {
        failures++;
      }
    }
  }

  if (failures > 0) {
    console.error(`Vision smoke failed: ${failures} request(s) failed.`);
    process.exit(1);
  }

  console.log("Vision smoke passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
