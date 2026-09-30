import {
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "crypto";
import { constants } from "fs";
import { lstat, mkdir, open, rename, unlink } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";

export type AuthenticationStatus = "enabled" | "disabled" | "unavailable";
export type AuthenticationResult =
  | "allowed"
  | "denied"
  | "unavailable"
  | "busy";

export interface HttpAuthentication {
  getStatus(): Promise<AuthenticationStatus>;
  authorize(key: string | undefined): Promise<AuthenticationResult>;
  configure(key: string | null): Promise<void>;
}

type AuthenticationRecord =
  | { version: 1; mode: "disabled" }
  | { version: 1; mode: "enabled"; salt: string; hash: string };

const MAX_RECORD_BYTES = 4096;

export function validateApiKey(key: string): string | undefined {
  if (key.length > 1024) {
    return "The API key must not exceed 1024 characters.";
  }
  if (!key || key !== key.trim() || !/^[\x20-\x7e]+$/.test(key)) {
    return "Use a non-empty printable ASCII key without surrounding whitespace.";
  }
  return undefined;
}

function deriveKey(key: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      key,
      Buffer.from(salt, "hex"),
      32,
      { N: 16384, r: 8, p: 1 },
      (error, hash) => {
        if (error) {
          reject(error);
        } else {
          resolve(hash);
        }
      },
    );
  });
}

function parseRecord(raw: string): AuthenticationRecord | undefined {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return undefined;
  }
  if (record.mode === "disabled" && Object.keys(record).length === 2) {
    return { version: 1, mode: "disabled" };
  }
  if (
    record.mode === "enabled" &&
    Object.keys(record).length === 4 &&
    typeof record.salt === "string" &&
    /^[a-f0-9]{32}$/.test(record.salt) &&
    typeof record.hash === "string" &&
    /^[a-f0-9]{64}$/.test(record.hash)
  ) {
    return {
      version: 1,
      mode: "enabled",
      salt: record.salt,
      hash: record.hash,
    };
  }
  return undefined;
}

export class FileHttpAuthentication implements HttpAuthentication {
  private readonly cacheKey = randomBytes(32);
  private successfulVerification?: string;
  private readonly pending = new Map<string, Promise<boolean>>();
  private readonly verificationQueue: Array<() => void> = [];
  private activeVerifications = 0;

  constructor(
    private readonly filePath = join(
      homedir(),
      ".agent-maestro",
      "http-auth.json",
    ),
  ) {}

  private async read(): Promise<
    { raw: string; record: AuthenticationRecord } | undefined
  > {
    try {
      if (!(await this.isPrivateDirectory())) {
        return undefined;
      }
      const file = await open(
        this.filePath,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.size > MAX_RECORD_BYTES ||
          (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
        ) {
          return undefined;
        }
        const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            length,
            buffer.length - length,
            null,
          );
          if (bytesRead === 0) {
            break;
          }
          length += bytesRead;
        }
        if (length > MAX_RECORD_BYTES) {
          return undefined;
        }
        const raw = buffer.toString("utf8", 0, length);
        const record = parseRecord(raw);
        return record ? { raw, record } : undefined;
      } finally {
        await file.close();
      }
    } catch {
      return undefined;
    }
  }

  private async isPrivateDirectory(): Promise<boolean> {
    const stat = await lstat(dirname(this.filePath));
    return (
      stat.isDirectory() &&
      (process.platform === "win32" ||
        ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.()))
    );
  }

  async getStatus(): Promise<AuthenticationStatus> {
    return (await this.read())?.record.mode ?? "unavailable";
  }

  async authorize(key: string | undefined): Promise<AuthenticationResult> {
    const snapshot = await this.read();
    if (!snapshot) {
      this.successfulVerification = undefined;
      return "unavailable";
    }
    const { raw, record } = snapshot;
    if (record.mode === "disabled") {
      this.successfulVerification = undefined;
      return "allowed";
    }
    if (key === undefined || validateApiKey(key)) {
      return "denied";
    }

    // The cache never retains the supplied key or bypasses the durable policy read.
    const verificationId =
      raw + createHmac("sha256", this.cacheKey).update(key).digest("hex");
    if (verificationId === this.successfulVerification) {
      return "allowed";
    }
    let verification = this.pending.get(verificationId);
    if (!verification) {
      // Two active derivations plus eight FIFO waiters accommodate short bursts.
      // Unknown credentials cannot be classified as valid before the KDF runs.
      if (this.pending.size >= 10) {
        return "busy";
      }
      verification = this.enqueueVerification(verificationId, key, record);
    }

    try {
      const valid = await verification;
      if ((await this.read())?.raw !== raw) {
        return "unavailable";
      }
      if (valid) {
        this.successfulVerification = verificationId;
      }
      return valid ? "allowed" : "denied";
    } catch {
      return "unavailable";
    }
  }

  private enqueueVerification(
    id: string,
    key: string,
    record: Extract<AuthenticationRecord, { mode: "enabled" }>,
  ): Promise<boolean> {
    const verification = new Promise<boolean>((resolve, reject) => {
      const run = () => {
        this.activeVerifications++;
        deriveKey(key, record.salt)
          .then((hash) =>
            timingSafeEqual(hash, Buffer.from(record.hash, "hex")),
          )
          .then(resolve, reject)
          .finally(() => {
            this.activeVerifications--;
            this.pending.delete(id);
            this.verificationQueue.shift()?.();
          });
      };
      if (this.activeVerifications < 2) {
        run();
      } else {
        this.verificationQueue.push(run);
      }
    });
    this.pending.set(id, verification);
    return verification;
  }

  async configure(key: string | null): Promise<void> {
    let record: AuthenticationRecord = { version: 1, mode: "disabled" };
    if (key !== null) {
      const error = validateApiKey(key);
      if (error) {
        throw new Error(error);
      }
      const salt = randomBytes(16).toString("hex");
      record = {
        version: 1,
        mode: "enabled",
        salt,
        hash: (await deriveKey(key, salt)).toString("hex"),
      };
    }

    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await this.isPrivateDirectory())) {
      throw new Error(
        `Cannot configure authentication in ${directory}. Use a real directory owned by the current OS user; on macOS/Linux set its permissions to 0700 (owner read/write/execute only), then retry Agent Maestro: Set API Key. Symlinks and directories owned by another user are not accepted.`,
      );
    }
    const temporaryPath = join(directory, `.http-auth-${randomUUID()}.tmp`);
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(record));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.filePath);
      this.successfulVerification = undefined;
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
  }
}
