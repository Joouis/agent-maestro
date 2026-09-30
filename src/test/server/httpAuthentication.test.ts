import * as assert from "assert";
import { fork } from "child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  FileHttpAuthentication,
  validateApiKey,
} from "../../server/httpAuthentication";

suite("File HTTP authentication", () => {
  let directory: string;
  let filePath: string;
  let authentication: FileHttpAuthentication;
  setup(async () => {
    directory = await mkdtemp(join(tmpdir(), "am-auth-test-"));
    filePath = join(directory, "http-auth.json");
    authentication = new FileHttpAuthentication(filePath);
  });
  teardown(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("missing state is unavailable until explicitly configured", async () => {
    assert.strictEqual(await authentication.getStatus(), "unavailable");
    assert.strictEqual(
      await authentication.authorize(undefined),
      "unavailable",
    );
    await authentication.configure(null);
    assert.strictEqual(await authentication.getStatus(), "disabled");
    assert.strictEqual(await authentication.authorize(undefined), "allowed");
    assert.deepStrictEqual(JSON.parse(await readFile(filePath, "utf8")), {
      version: 1,
      mode: "disabled",
    });
  });

  test("stores a salted verifier and verifies keys without plaintext persistence", async () => {
    await authentication.configure("strong-review-key");
    const first = await readFile(filePath, "utf8");
    assert.ok(!first.includes("strong-review-key"));
    assert.strictEqual(
      await authentication.authorize("strong-review-key"),
      "allowed",
    );
    assert.strictEqual(await authentication.authorize("wrong-key"), "denied");
    assert.strictEqual(await authentication.authorize(undefined), "denied");
    await authentication.configure("strong-review-key");
    assert.notStrictEqual(await readFile(filePath, "utf8"), first);
    if (process.platform !== "win32") {
      assert.strictEqual((await stat(filePath)).mode & 0o777, 0o600);
    }
  });

  test("independent instances observe rotation and disable without events", async () => {
    const peer = new FileHttpAuthentication(filePath);
    await authentication.configure("first-key");
    assert.strictEqual(await peer.authorize("first-key"), "allowed");
    await authentication.configure("second-key");
    assert.strictEqual(await peer.authorize("first-key"), "denied");
    assert.strictEqual(await peer.authorize("second-key"), "allowed");
    await authentication.configure(null);
    assert.strictEqual(await peer.authorize(undefined), "allowed");
  });

  test("cached success cannot hide deletion, corruption, or recovery", async () => {
    await authentication.configure("test-key");
    assert.strictEqual(await authentication.authorize("test-key"), "allowed");
    await unlink(filePath);
    assert.strictEqual(
      await authentication.authorize("test-key"),
      "unavailable",
    );
    await writeFile(filePath, "{broken", { mode: 0o600 });
    assert.strictEqual(
      await authentication.authorize("test-key"),
      "unavailable",
    );
    await authentication.configure("test-key");
    assert.strictEqual(await authentication.authorize("test-key"), "allowed");
  });

  test("rejects unsupported, incomplete, and oversized records", async () => {
    for (const raw of [
      "null",
      "[]",
      '{"version":2,"mode":"disabled"}',
      '{"version":1,"mode":"enabled"}',
      '{"version":1,"mode":"disabled","extra":true}',
      " ".repeat(4097),
    ]) {
      await writeFile(filePath, raw, { mode: 0o600 });
      assert.strictEqual(
        await authentication.authorize("test-key"),
        "unavailable",
        raw.slice(0, 100),
      );
    }
  });

  test("rejects unsafe permissions and symbolic links", async function () {
    if (process.platform === "win32") {
      this.skip();
    }
    await authentication.configure(null);
    await chmod(filePath, 0o644);
    assert.strictEqual(await authentication.getStatus(), "unavailable");
    await chmod(filePath, 0o600);
    const link = join(directory, "link.json");
    await symlink(filePath, link);
    assert.strictEqual(
      await new FileHttpAuthentication(link).getStatus(),
      "unavailable",
    );
  });

  test("failed publication leaves the existing destination intact and cleans temporary files", async () => {
    await mkdir(filePath);
    await writeFile(join(filePath, "sentinel"), "unchanged");
    await assert.rejects(authentication.configure(null));
    assert.strictEqual(
      await readFile(join(filePath, "sentinel"), "utf8"),
      "unchanged",
    );
    assert.deepStrictEqual(await readdir(directory), ["http-auth.json"]);
  });

  test("invalid configuration does not overwrite a working policy", async () => {
    await authentication.configure(null);
    const before = await readFile(filePath, "utf8");
    for (const key of ["", " space", "newline\n", "中文", "x".repeat(1025)]) {
      assert.ok(validateApiKey(key));
      await assert.rejects(authentication.configure(key));
      assert.strictEqual(await readFile(filePath, "utf8"), before);
    }
  });

  test("concurrent publications leave one complete policy", async () => {
    const peer = new FileHttpAuthentication(filePath);
    await Promise.all([authentication.configure("one"), peer.configure("two")]);
    const checks = await Promise.all([
      authentication.authorize("one"),
      authentication.authorize("two"),
    ]);
    assert.deepStrictEqual(checks.sort(), ["allowed", "denied"]);
    assert.deepStrictEqual(await readdir(directory), ["http-auth.json"]);
  });

  test("bounds concurrent invalid verifications and recovers afterward", async () => {
    await authentication.configure("valid-key");
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        authentication.authorize(`invalid-${i}`),
      ),
    );
    assert.ok(results.includes("busy"));
    assert.ok(
      results.every((result) => result === "denied" || result === "busy"),
    );
    assert.strictEqual(await authentication.authorize("valid-key"), "allowed");
  });

  test("a valid uncached key survives a burst of two wrong keys", async () => {
    await authentication.configure("valid-key");
    const results = await Promise.all([
      authentication.authorize("wrong-one"),
      authentication.authorize("wrong-two"),
      authentication.authorize("valid-key"),
    ]);
    assert.deepStrictEqual(results, ["denied", "denied", "allowed"]);
  });

  test("unsafe existing directory has an actionable recovery error", async function () {
    if (process.platform === "win32") {
      this.skip();
    }
    await authentication.configure("existing-key");
    const original = await readFile(filePath, "utf8");
    await chmod(directory, 0o755);
    await assert.rejects(
      authentication.configure("replacement-key"),
      (error: Error) => {
        assert.ok(error.message.includes(directory));
        assert.match(error.message, /0700/);
        assert.match(error.message, /Set API Key/);
        return true;
      },
    );
    assert.strictEqual(await readFile(filePath, "utf8"), original);
    assert.strictEqual(
      await authentication.authorize("existing-key"),
      "unavailable",
    );
    assert.strictEqual((await stat(directory)).mode & 0o777, 0o755);
    await chmod(directory, 0o700);
    await authentication.configure("replacement-key");
    assert.strictEqual(
      await authentication.authorize("replacement-key"),
      "allowed",
    );
  });

  test("identical concurrent keys share verification without overload", async () => {
    await authentication.configure("valid-key");
    const results = await Promise.all(
      Array.from({ length: 12 }, () => authentication.authorize("valid-key")),
    );
    assert.ok(results.every((result) => result === "allowed"));
  });

  test("another process observes changes on each admission", async function () {
    this.timeout(10000);
    const workerPath = join(directory, "worker.cjs");
    const modulePath = join(__dirname, "../../server/httpAuthentication.js");
    await writeFile(
      workerPath,
      `const {FileHttpAuthentication}=require(${JSON.stringify(modulePath)});
const auth=new FileHttpAuthentication(process.argv[2]);
process.on('message',async ({key})=>process.send(await auth.authorize(key)));`,
    );
    const child = fork(workerPath, [filePath], {
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const check = (key?: string): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const onError = (error: Error) => {
          child.off("message", onMessage);
          reject(error);
        };
        const onMessage = (message: unknown) => {
          child.off("error", onError);
          resolve(message);
        };
        child.once("error", onError);
        child.once("message", onMessage);
        child.send({ key });
      });
    try {
      assert.strictEqual(await check(), "unavailable");
      await authentication.configure("first");
      assert.strictEqual(await check("first"), "allowed");
      await authentication.configure("second");
      assert.strictEqual(await check("first"), "denied");
      assert.strictEqual(await check("second"), "allowed");
      await unlink(filePath);
      assert.strictEqual(await check("second"), "unavailable");
      await authentication.configure(null);
      assert.strictEqual(await check(), "allowed");
    } finally {
      child.kill();
    }
  });
});
