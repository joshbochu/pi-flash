import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

export interface StateLockOptions {
  isProcessAlive?: (pid: number) => boolean;
  processIdentity?: (pid: number) => Promise<string | null>;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

export class StateLockError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StateLockError";
  }
}

interface LockOwner {
  version: 1;
  pid: number;
  processIdentity?: string;
  acquiredAt: string;
  nonce: string;
}

/**
 * Runs an action under an interprocess filesystem lock.
 *
 * The public lock is a hard link to a fully-written, per-acquisition owner
 * file. Linking is atomic across processes. A dead owner can be unlinked
 * without a check-then-rename race: once unlink returns, the stale link is
 * gone, and a later owner is a separate link created after that operation.
 */
export async function withFileLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  options: StateLockOptions = {},
): Promise<T> {
  const lockDirectory = dirname(lockPath);
  const nonce = randomUUID();
  const ownerPath = join(lockDirectory, `.${basename(lockPath)}.${process.pid}.${nonce}.owner`);
  const processIdentity = await getProcessIdentity(process.pid, options);
  const owner: LockOwner = {
    version: 1,
    pid: process.pid,
    ...(processIdentity === null ? {} : { processIdentity }),
    acquiredAt: new Date().toISOString(),
    nonce,
  };
  const timeoutMs = options.lockTimeoutMs ?? 10_000;
  const retryMs = options.lockRetryMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let acquired = false;

  try {
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
    await chmod(lockDirectory, 0o700);
    handle = await open(ownerPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    while (!acquired) {
      try {
        await link(ownerPath, lockPath);
        acquired = true;
      } catch (error: unknown) {
        if (!isAlreadyExists(error)) {
          throw new StateLockError(`Could not acquire state lock ${lockPath}.`, { cause: asError(error) });
        }
        const inspection = await inspectLockOwner(lockPath, options);
        if (inspection.dead) {
          await unlink(lockPath).catch((unlinkError: unknown) => {
            if (!isNotFound(unlinkError)) throw unlinkError;
          });
          if (inspection.owner) {
            const staleOwnerPath = join(
              lockDirectory,
              `.${basename(lockPath)}.${inspection.owner.pid}.${inspection.owner.nonce}.owner`,
            );
            await unlink(staleOwnerPath).catch((unlinkError: unknown) => {
              if (!isNotFound(unlinkError)) throw unlinkError;
            });
          }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new StateLockError(`Timed out waiting for state lock ${lockPath}.`);
        }
        await delay(retryMs);
      }
    }

    return await action();
  } finally {
    await handle?.close().catch(() => undefined);
    if (acquired) {
      const current = await readLockOwner(lockPath);
      if (current?.nonce === nonce) {
        await unlink(lockPath).catch((error: unknown) => {
          if (!isNotFound(error)) throw error;
        });
      }
    }
    await unlink(ownerPath).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

export function isPidAlive(pid: number, options: StateLockOptions = {}): boolean {
  if (options.isProcessAlive) return options.isProcessAlive(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH");
  }
}

export async function getProcessIdentity(pid: number, options: StateLockOptions = {}): Promise<string | null> {
  if (options.processIdentity) return options.processIdentity(pid);
  try {
    const { stdout } = await promisify(execFile)("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const identity = stdout.trim();
    return identity === "" ? null : identity;
  } catch {
    return null;
  }
}

async function inspectLockOwner(
  lockPath: string,
  options: StateLockOptions,
): Promise<{ dead: boolean; owner: LockOwner | null }> {
  const owner = await readLockOwner(lockPath);
  if (owner === null) {
    // Owner files are linked only after their contents are closed and synced.
    // A malformed lock is not an in-progress write, but fail closed briefly.
    try {
      const details = await stat(lockPath);
      return { dead: Date.now() - details.mtimeMs >= 60_000, owner: null };
    } catch (error: unknown) {
      if (isNotFound(error)) return { dead: false, owner: null };
      throw error;
    }
  }
  if (!isPidAlive(owner.pid, options)) return { dead: true, owner };
  if (owner.processIdentity === undefined) return { dead: false, owner };
  const currentIdentity = await getProcessIdentity(owner.pid, options);
  return {
    dead: currentIdentity !== null && currentIdentity !== owner.processIdentity,
    owner,
  };
}

async function readLockOwner(path: string): Promise<LockOwner | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const owner = value as Record<string, unknown>;
  if (
    owner.version !== 1
    || typeof owner.pid !== "number"
    || !Number.isSafeInteger(owner.pid)
    || owner.pid < 1
    || typeof owner.acquiredAt !== "string"
    || Number.isNaN(Date.parse(owner.acquiredAt))
    || typeof owner.nonce !== "string"
    || !/^[0-9a-f-]{36}$/i.test(owner.nonce)
    || (owner.processIdentity !== undefined && (typeof owner.processIdentity !== "string" || owner.processIdentity === ""))
  ) return null;
  return {
    version: 1,
    pid: owner.pid,
    ...(owner.processIdentity === undefined ? {} : { processIdentity: owner.processIdentity as string }),
    acquiredAt: owner.acquiredAt,
    nonce: owner.nonce,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}
