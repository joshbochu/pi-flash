import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, statSync, writeSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

export interface PiInvocation {
  command: string;
  args: string[];
}

export interface ReplacementRequest {
  targetCwd: string;
  invocation: PiInvocation;
  env?: NodeJS.ProcessEnv;
}

type Execve = (file: string, args?: readonly string[], env?: NodeJS.ProcessEnv) => never;

export interface ProcessReplacementOptions {
  changeDirectory?: (directory: string) => void;
  execve?: Execve;
}

/**
 * Finds a self-contained way to re-enter the exact Pi executable currently
 * running this extension. Packaged Pi uses a script plus Node/Bun; direct
 * native launchers can execute themselves. Falling back to `pi` keeps normal
 * PATH-based installations working too.
 */
export function getCurrentPiInvocation(
  runtimePath = process.execPath,
  currentScript = process.argv[1],
): PiInvocation {
  const bunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;
  if (currentScript && !bunVirtualScript && existsSync(currentScript)) {
    return { command: runtimePath, args: [resolve(currentScript)] };
  }
  const executable = runtimePath.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (/^(node|bun)(\.exe)?$/.test(executable)) return { command: "pi", args: [] };
  return { command: runtimePath, args: [] };
}

/** Ensures the replacement gets no explicit Pi session selection. */
export function createFreshPiEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("PI_SESSION_")) delete environment[key];
  }
  return environment;
}

/** Validates all preconditions before the parent begins terminal shutdown. */
export function assertReplacementRequest(request: ReplacementRequest): void {
  if (!isAbsolute(request.targetCwd)) throw new Error("Pi Flash handoff requires an absolute worktree path");
  if (request.invocation.command.trim() === "") throw new Error("Pi Flash could not determine how to launch Pi");
}

/** Resolves a command before shutdown because execve deliberately does no PATH lookup. */
export function resolveExecutable(command: string, environment: NodeJS.ProcessEnv = process.env): string {
  const candidates = isAbsolute(command)
    ? [command]
    : (environment.PATH ?? "").split(delimiter).map((directory) => resolve(directory || ".", command));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`Pi Flash could not find an executable launcher for ${JSON.stringify(command)}`);
}

/**
 * Atomically replaces the current process with a blank Pi in the worktree.
 * The PID, process group, and inherited terminal descriptors stay unchanged.
 */
export function replaceCurrentProcess(
  request: ReplacementRequest,
  options: ProcessReplacementOptions = {},
): never {
  assertReplacementRequest(request);
  const execve = options.execve ?? process.execve;
  if (!execve) {
    throw new Error("Pi Flash process replacement requires Node.js execve support on this platform");
  }
  const environment = createFreshPiEnvironment(request.env);
  environment.PWD = request.targetCwd;
  const command = resolveExecutable(request.invocation.command, environment);
  (options.changeDirectory ?? process.chdir)(request.targetCwd);
  return execve(command, [command, ...request.invocation.args], environment);
}

/** Compatibility path for Pi runtimes, such as Bun, that lack process.execve. */
export function startReplacementChild(request: ReplacementRequest): ChildProcess {
  assertReplacementRequest(request);
  const environment = createFreshPiEnvironment(request.env);
  environment.PWD = request.targetCwd;
  const command = resolveExecutable(request.invocation.command, environment);
  return spawn(command, request.invocation.args, {
    cwd: request.targetCwd,
    env: environment,
    stdio: "inherit",
    detached: false,
  });
}

export class HandoffController {
  private pending: ReplacementRequest | undefined;
  private exitListener: (() => void) | undefined;

  public preflight(targetCwd: string): ReplacementRequest {
    const environment = createFreshPiEnvironment();
    const invocation = getCurrentPiInvocation();
    invocation.command = resolveExecutable(invocation.command, environment);
    const request: ReplacementRequest = { targetCwd, invocation, env: environment };
    assertReplacementRequest(request);
    return request;
  }

  /** Records a fully preflighted request; it does not replace the process yet. */
  public schedule(request: ReplacementRequest): void {
    if (this.pending || this.exitListener) throw new Error("Pi Flash already has a replacement Pi pending");
    assertReplacementRequest(request);
    this.pending = request;
  }

  /**
   * Completes the handoff after Pi's asynchronous shutdown work. Node arms an
   * exit listener; runtimes without execve wait for the compatible child.
   */
  public async completePendingReplacement(): Promise<void> {
    const request = this.pending;
    this.pending = undefined;
    if (!request) return;

    if (!process.execve) {
      await waitForReplacementChild(startReplacementChild(request));
      return;
    }

    const listener = () => {
      this.exitListener = undefined;
      try {
        replaceCurrentProcess(request);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        try {
          writeSync(process.stderr.fd, `Pi Flash could not start the replacement Pi: ${detail}\n`);
        } catch {
          // The process is already exiting; there is no further recovery path.
        }
      }
    };
    this.exitListener = listener;
    process.once("exit", listener);
  }

  public cancel(): void {
    this.pending = undefined;
    if (this.exitListener) process.removeListener("exit", this.exitListener);
    this.exitListener = undefined;
  }
}

async function waitForReplacementChild(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("error", (error) => {
      process.stderr.write(`Pi Flash could not start the replacement Pi: ${error.message}\n`);
      finish();
    });
    child.once("close", finish);
  });
}
