/**
 * Multi-turn e2e: drives real CLIs against a running Agent Maestro proxy.
 *
 *   codex       -> POST /api/openai/v1/responses
 *   claude code -> POST /api/anthropic/v1/messages
 *   gemini cli  -> POST /api/gemini/v1beta/models/<m>:streamGenerateContent
 *
 * Turn 1 asks the client to remember a codeword; turn 2 resumes the session
 * and asks for it, proving history round-trips through the proxy.
 *
 * Usage:
 *   node --experimental-strip-types scripts/e2e-multiturn.ts [codex|claude|gemini ...]
 * Env: AGENT_MAESTRO_PORT (23333), AGENT_MAESTRO_KEY, E2E_CODEX_MODEL,
 *      E2E_CLAUDE_MODEL, E2E_GEMINI_MODEL
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const PORT = process.env.AGENT_MAESTRO_PORT ?? "23333";
const BASE = `http://127.0.0.1:${PORT}/api`;
const KEY = process.env.AGENT_MAESTRO_KEY ?? "dummy";
const TIMEOUT_MS = 5 * 60_000;

const WORD = `MAESTRO-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const TURN1 = `Remember this codeword: ${WORD}. Do not use any tools. Reply with only the word OK.`;
const TURN2 =
  "What was the codeword I asked you to remember? Do not use any tools. Reply with only the codeword.";

interface Result {
  client: string;
  ok: boolean;
  detail: string;
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): string {
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} exited ${r.status}: ${(r.stderr || r.stdout).slice(-800)}`,
    );
  }
  return r.stdout;
}

function tmp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `am-e2e-${name}-`));
}

function lastJsonLines(out: string): unknown[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

function codex(): [string, string] {
  const model = process.env.E2E_CODEX_MODEL ?? "gpt-5.6-sol";
  const home = tmp("codex-home");
  const cwd = tmp("codex-cwd");
  const env = { CODEX_HOME: home, AM_E2E_KEY: KEY };
  const base = [
    "-c",
    `model="${model}"`,
    "-c",
    'model_provider="am"',
    "-c",
    'model_providers.am={name="am",base_url="' +
      `${BASE}/openai/v1",wire_api="responses",env_key="AM_E2E_KEY"}`,
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
  ];
  const text = (out: string): string => {
    const msgs = lastJsonLines(out).filter(
      (e: any) => e?.item?.type === "agent_message",
    ) as any[];
    return msgs.at(-1)?.item?.text ?? "";
  };
  const t1 = text(run("codex", ["exec", ...base, TURN1], cwd, env));
  const t2 = text(
    run(
      "codex",
      ["exec", "resume", "--last", ...base.slice(0, -2), TURN2],
      cwd,
      env,
    ),
  );
  return [t1, t2];
}

function claude(): [string, string] {
  const model = process.env.E2E_CLAUDE_MODEL ?? "claude-sonnet-5.5";
  const cwd = tmp("claude-cwd");
  const env = {
    ANTHROPIC_BASE_URL: `${BASE}/anthropic`,
    ANTHROPIC_API_KEY: KEY,
    ANTHROPIC_AUTH_TOKEN: KEY,
    CLAUDE_CONFIG_DIR: tmp("claude-home"),
  };
  const sessionId = crypto.randomUUID();
  const common = [
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--tools",
    "",
  ];
  const text = (out: string): string => JSON.parse(out).result ?? "";
  const t1 = text(
    run("claude", [...common, "--session-id", sessionId, TURN1], cwd, env),
  );
  const t2 = text(
    run("claude", [...common, "--resume", sessionId, TURN2], cwd, env),
  );
  return [t1, t2];
}

function gemini(): [string, string] {
  const model = process.env.E2E_GEMINI_MODEL ?? "gemini-3.8-flash";
  const home = tmp("gemini-home");
  const cwd = tmp("gemini-cwd");
  fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".gemini", "settings.json"),
    JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }),
  );
  const env = {
    GEMINI_CLI_HOME: home,
    GOOGLE_GEMINI_BASE_URL: `${BASE}/gemini`,
    GEMINI_API_KEY: KEY,
    GEMINI_CLI_TRUST_WORKSPACE: "true",
  };
  const common = ["-m", model, "-o", "json", "--approval-mode", "plan"];
  const text = (out: string): string => {
    const start = out.indexOf("{");
    return JSON.parse(out.slice(start)).response ?? "";
  };
  const t1 = text(run("gemini", [...common, "-p", TURN1], cwd, env));
  const t2 = text(
    run("gemini", [...common, "-r", "latest", "-p", TURN2], cwd, env),
  );
  return [t1, t2];
}

const CLIENTS: Record<string, () => [string, string]> = {
  codex,
  claude,
  gemini,
};

const selected = process.argv.slice(2).length
  ? process.argv.slice(2)
  : Object.keys(CLIENTS);

const results: Result[] = [];
for (const name of selected) {
  const fn = CLIENTS[name];
  if (!fn) {
    console.error(`unknown client: ${name}`);
    process.exit(2);
  }
  const started = Date.now();
  try {
    const [t1, t2] = fn();
    const ok = t2.includes(WORD);
    results.push({
      client: name,
      ok,
      detail: `${((Date.now() - started) / 1000).toFixed(1)}s turn1=${JSON.stringify(t1.slice(0, 40))} turn2=${JSON.stringify(t2.slice(0, 80))}`,
    });
  } catch (e) {
    results.push({ client: name, ok: false, detail: (e as Error).message });
  }
}

for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.client}: ${r.detail}`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
