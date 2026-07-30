import { spawn } from "node:child_process";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_FORCE_SETTLE_MS = 1_000;

export interface CommandResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly result?: CommandResult,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Maximum bytes retained for each output stream. Streams are still drained. */
  maxOutputBytes?: number;
  /** Time allowed for graceful SIGTERM handling before SIGKILL. */
  terminationGraceMs?: number;
  /** Last-resort deadline after SIGKILL before the promise settles. */
  forceSettleMs?: number;
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    const maxOutputBytes = requireNonNegativeInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes");
    const terminationGraceMs = requireNonNegativeInteger(options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS, "terminationGraceMs");
    const forceSettleMs = requireNonNegativeInteger(options.forceSettleMs ?? DEFAULT_FORCE_SETTLE_MS, "forceSettleMs");
    const timeoutMs = options.timeoutMs === undefined
      ? undefined
      : requireNonNegativeInteger(options.timeoutMs, "timeoutMs");
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      // A dedicated process group lets cancellation terminate descendants that
      // inherited the captured pipes instead of leaving the promise hung.
      detached: process.platform !== "win32",
    });
    const stdout = new BoundedOutput(maxOutputBytes);
    const stderr = new BoundedOutput(maxOutputBytes);
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let forceSettleTimer: NodeJS.Timeout | undefined;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      options.signal?.removeEventListener("abort", abortCommand);
      callback();
    };

    const result = (): CommandResult => ({
      code: exitCode ?? 1,
      signal: exitSignal,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      timedOut,
      aborted,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    });

    const settleAfterForcedTermination = () => {
      // SIGKILL should normally produce `close` immediately. This deadline
      // protects callers from an uninterruptible process or inherited pipe.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish(() => resolve(result()));
    };

    const terminate = () => {
      // `exit` can precede `close` when a descendant inherited stdout/stderr.
      // Keep terminating the process group until the captured pipes close.
      if (settled || forceKillTimer || forceSettleTimer) return;
      signalProcess(child.pid, "SIGTERM", child.kill.bind(child));
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined;
        signalProcess(child.pid, "SIGKILL", child.kill.bind(child));
        forceSettleTimer = setTimeout(settleAfterForcedTermination, forceSettleMs);
        forceSettleTimer.unref();
      }, terminationGraceMs);
      forceKillTimer.unref();
    };

    const abortCommand = () => {
      aborted = true;
      terminate();
    };

    child.stdout.on("data", (chunk: Buffer | string) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => stderr.append(chunk));
    child.once("error", (error) => {
      finish(() => reject(new CommandError(`could not start ${command}: ${error.message}`)));
    });
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.once("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      finish(() => resolve(result()));
    });
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timeout.unref();
    }
    if (options.signal) {
      if (options.signal.aborted) abortCommand();
      else options.signal.addEventListener("abort", abortCommand, { once: true });
    }
  });
}

export async function requireCommand(command: string): Promise<void> {
  const result = await runCommand(command, ["--version"], { timeoutMs: 5_000 });
  if (result.code !== 0) {
    throw new CommandError(`${command} is required but unavailable`, result);
  }
}

class BoundedOutput {
  readonly #chunks: Buffer[] = [];
  readonly #limit: number;
  #length = 0;
  truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = this.#limit - this.#length;
    if (remaining > 0) {
      const retained = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      this.#chunks.push(retained);
      this.#length += retained.length;
    }
    if (chunk.length > Math.max(remaining, 0)) this.truncated = true;
  }

  toString(): string {
    return Buffer.concat(this.#chunks, this.#length).toString("utf8");
  }
}

function signalProcess(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: (signal?: NodeJS.Signals | number) => boolean,
): void {
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error: unknown) {
      if (!isMissingProcess(error)) return;
    }
  }
  try {
    fallback(signal);
  } catch {
    // The process may have exited between the status check and signal.
  }
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function isMissingProcess(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ESRCH";
}
