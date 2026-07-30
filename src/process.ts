import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly result?: CommandResult,
  ) {
    super(message);
  }
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timeout: NodeJS.Timeout | undefined;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => child.kill("SIGTERM");

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      finish(() => reject(new CommandError(`could not start ${command}: ${error.message}`)));
    });
    child.once("close", (code) => {
      finish(() =>
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          timedOut,
        }),
      );
    });
    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }
  });
}

export async function requireCommand(command: string): Promise<void> {
  const result = await runCommand(command, ["--version"], { timeoutMs: 5_000 });
  if (result.code !== 0) {
    throw new CommandError(`${command} is required but unavailable`, result);
  }
}
