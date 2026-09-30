// Run after pnpm build-tests; pass an absolute VS Code executable as argv[2].
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const code = process.argv[2];
if (!code) {
  throw new Error(
    "Pass the absolute VS Code executable path. Run pnpm build-tests first.",
  );
}
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "am-http-auth-windows-"));
const policyDirectory = join(root, "policy");
await mkdir(policyDirectory, { mode: 0o700 });
const policyFile = join(policyDirectory, "http-auth.json");
const processes = [];
const ports = new Map();
const results = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(role, path = "/", method = "GET") {
  const response = await fetch(`http://127.0.0.1:${ports.get(role)}${path}`, {
    method,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function waitFor(test, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!(await test())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out; inspect the temporary test logs.");
    }
    await delay(100);
  }
}

try {
  for (const role of ["owner", "peer"]) {
    const fixture = join(root, role + "-extension");
    await mkdir(fixture);
    await cp(join(repository, "out"), join(fixture, "out"), {
      recursive: true,
    });
    await symlink(
      join(repository, "node_modules"),
      join(fixture, "node_modules"),
      "junction",
    );
    await mkdir(join(root, role));
    await writeFile(
      join(fixture, "package.json"),
      JSON.stringify({
        name: "auth-probe",
        publisher: "local-test",
        version: "0.0.1",
        engines: { vscode: "^1.120.0" },
        main: "main.cjs",
        activationEvents: ["*"],
      }),
    );
    await writeFile(
      join(fixture, "main.cjs"),
      `
const vscode = require('vscode');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { FileHttpAuthentication } = require(${JSON.stringify(join(fixture, "out/server/httpAuthentication.js"))});
const { ProxyServer } = require(${JSON.stringify(join(fixture, "out/server/ProxyServer.js"))});
const { registerLlmApiKeyCommands } = require(${JSON.stringify(join(fixture, "out/commands/llmApiKeyCommands.js"))});
exports.activate = async context => {
 const role = path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '');
 if (role !== ${JSON.stringify(role)}) return;
 const authentication = new FileHttpAuthentication(${JSON.stringify(policyFile)});
 const proxy = new ProxyServer({getExtensionStatus:()=>({})}, 0, context, authentication);
 registerLlmApiKeyCommands(authentication, context);
 const server = http.createServer(async (req, res) => {
  try {
   const url = new URL(req.url, 'http://localhost');
   if (req.method === 'POST' && (url.pathname === '/set' || url.pathname === '/disable')) {
    const pick = vscode.window.showQuickPick;
    const input = vscode.window.showInputBox;
    const info = vscode.window.showInformationMessage;
    const warning = vscode.window.showWarningMessage;
    try {
     vscode.window.showQuickPick = async choices => choices.find(c => c.action === (url.pathname === '/disable' ? 'disable' : 'set'));
     vscode.window.showInputBox = async () => url.searchParams.get('key');
     vscode.window.showInformationMessage = async () => undefined;
     vscode.window.showWarningMessage = async (_message, options) => {
      if (!options.modal) throw new Error('Expected explicit disable confirmation');
      return 'Disable authentication';
     };
     await vscode.commands.executeCommand('agent-maestro.setLlmApiKey');
    } finally {
     vscode.window.showQuickPick = pick; vscode.window.showInputBox = input; vscode.window.showInformationMessage = info; vscode.window.showWarningMessage = warning;
    }
   }
   if (req.method === 'POST' && url.pathname === '/close') {
    res.end('{}'); setTimeout(()=>vscode.commands.executeCommand('workbench.action.closeWindow'),100); return;
   }
   const status = {role,state:await authentication.getStatus(),anonymous:(await proxy.app.request('/api/v1/info')).status,first:(await proxy.app.request('/api/v1/info',{headers:{Authorization:'Bearer test-first-key'}})).status,second:(await proxy.app.request('/api/v1/info',{headers:{Authorization:'Bearer test-second-key'}})).status,health:(await proxy.app.request('/health')).status};
   res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(status));
  } catch (error) {res.writeHead(500);res.end(String(error));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 fs.writeFileSync(${JSON.stringify(join(root, role + "-port.json"))}, JSON.stringify({port:server.address().port}));
 context.subscriptions.push({dispose:()=>server.close()});
};
`,
    );
    const log = createWriteStream(join(root, role + ".log"));
    const child = spawn(
      code,
      [
        "--user-data-dir=" + join(root, "user-data"),
        "--extensions-dir=" + join(root, "extensions"),
        "--extensionDevelopmentPath=" + fixture,
        "--profile",
        "AM auth " + role,
        "--new-window",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-updates",
        "--use-inmemory-secretstorage",
        join(root, role),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    processes.push(child);
    await waitFor(async () => {
      try {
        ports.set(
          role,
          JSON.parse(await readFile(join(root, role + "-port.json"), "utf8"))
            .port,
        );
        return true;
      } catch {
        return false;
      }
    });
    const initial = await request(role);
    assert.equal(initial.anonymous, 503);
    assert.equal(initial.health, 200);
    results.push({ stage: "initial", ...initial });
  }
  await request("peer", "/set?key=test-first-key", "POST");
  let status = await request("owner");
  assert.equal(status.anonymous, 401);
  assert.equal(status.first, 200);
  results.push({ stage: "enabled-from-peer", ...status });
  await request("peer", "/set?key=test-second-key", "POST");
  status = await request("owner");
  assert.equal(status.first, 401);
  assert.equal(status.second, 200);
  results.push({ stage: "rotated-from-peer", ...status });
  await rm(policyFile);
  status = await request("owner");
  assert.equal(status.second, 503);
  results.push({ stage: "missing-policy", ...status });
  await writeFile(policyFile, "invalid", { mode: 0o600 });
  status = await request("owner");
  assert.equal(status.second, 503);
  results.push({ stage: "corrupt-policy", ...status });
  await request("peer", "/disable", "POST");
  status = await request("owner");
  assert.equal(status.anonymous, 200);
  results.push({ stage: "explicit-disable-recovery", ...status });
  if (process.platform !== "win32") {
    await chmod(policyFile, 0o644);
    assert.equal((await request("owner")).anonymous, 503);
    await chmod(policyFile, 0o600);
    assert.equal((await request("owner")).anonymous, 200);
  }
  await writeFile(join(root, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ passed: true, root, results }));
} finally {
  for (const role of [...ports.keys()].reverse()) {
    try {
      await request(role, "/close", "POST");
    } catch {}
  }
  await delay(500);
  for (const child of processes) {
    if (child.exitCode === null) {
      child.kill();
    }
  }
  console.log("Test artifacts: " + root);
}
