import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface PiInvocation {
  command: string;
  args: string[];
}

export interface ReplacementRequest {
  targetCwd: string;
  invocation: PiInvocation;
  env?: NodeJS.ProcessEnv;
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
    return { command: runtimePath, args: [currentScript] };
  }
  const executable = runtimePath.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (/^(node|bun)(\.exe)?$/.test(executable)) return { command: "pi", args: [] };
  return { command: runtimePath, args: [] };
}

/** Ensures the child gets no explicit Pi session selection from this process. */
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

/**
 * Starts a blank Pi as a child of the initiating Pi. The shutdown handler must
 * await this child: keeping the original foreground job alive prevents the
 * user's shell from reclaiming the terminal before the replacement enables
 * raw mode.
 */
export function startReplacement(request: ReplacementRequest): ChildProcess {
  assertReplacementRequest(request);
  const child = spawn(
    request.invocation.command,
    request.invocation.args,
    { cwd: request.targetCwd, env: createFreshPiEnvironment(request.env), stdio: "inherit", detached: false },
  );
  return child;
}

export class HandoffController {
  private pending: ReplacementRequest | undefined;

  public preflight(targetCwd: string): ReplacementRequest {
    const request: ReplacementRequest = { targetCwd, invocation: getCurrentPiInvocation() };
    assertReplacementRequest(request);
    return request;
  }

  /** Records a fully preflighted request; it does not spawn a process yet. */
  public schedule(request: ReplacementRequest): void {
    if (this.pending) throw new Error("Pi Flash already has a replacement Pi pending");
    assertReplacementRequest(request);
    this.pending = request;
  }

  /**
   * Called only from Pi's graceful session-shutdown event, after Pi has
   * restored the terminal. Resolves when the replacement exits so the
   * initiating foreground job remains alive for the replacement's lifetime.
   */
  public async runPending(): Promise<void> {
    const request = this.pending;
    this.pending = undefined;
    if (!request) return;
    const child = startReplacement(request);
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

  public cancel(): void {
    this.pending = undefined;
  }
}
