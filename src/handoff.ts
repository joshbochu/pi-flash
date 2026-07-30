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
  parentPid?: number;
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
  if (!Number.isSafeInteger(request.parentPid ?? process.pid) || (request.parentPid ?? process.pid) < 1) {
    throw new Error("Pi Flash handoff requires a valid parent process id");
  }
  if (!isAbsolute(request.targetCwd)) throw new Error("Pi Flash handoff requires an absolute worktree path");
  if (request.invocation.command.trim() === "") throw new Error("Pi Flash could not determine how to launch Pi");
}

/**
 * Starts a waiter that inherits this terminal and execs a blank Pi only after
 * its parent has fully exited. Dynamic values are positional shell arguments,
 * never shell source, so paths cannot become commands.
 */
export function startReplacement(request: ReplacementRequest): ChildProcess {
  assertReplacementRequest(request);
  const parentPid = request.parentPid ?? process.pid;
  const script = [
    'parent_pid="$1"',
    'target_cwd="$2"',
    'launcher="$3"',
    "shift 3",
    "while kill -0 \"$parent_pid\" 2>/dev/null; do sleep 0.05; done",
    'cd "$target_cwd" || exit 126',
    'exec "$launcher" "$@"',
  ].join("\n");
  const child = spawn(
    "/bin/sh",
    ["-c", script, "pi-flash-handoff", String(parentPid), request.targetCwd, request.invocation.command, ...request.invocation.args],
    { cwd: request.targetCwd, env: createFreshPiEnvironment(request.env), stdio: "inherit", detached: false },
  );
  child.unref();
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

  /** Called only from Pi's graceful session-shutdown event. */
  public spawnPending(): void {
    const request = this.pending;
    this.pending = undefined;
    if (request) startReplacement(request);
  }

  public cancel(): void {
    this.pending = undefined;
  }
}
