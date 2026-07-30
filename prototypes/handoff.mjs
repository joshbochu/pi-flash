import { spawn } from "node:child_process";

/**
 * Start a replacement process only after parentPid has released the terminal.
 *
 * The caller is responsible for invoking Pi's graceful shutdown immediately
 * after this function succeeds. Every value that can contain user data is
 * passed as a positional shell argument, never interpolated into the script.
 */
export function startReplacement({ targetCwd, launcher, launcherArgs = [], env = process.env, parentPid = process.pid }) {
  if (!Number.isSafeInteger(parentPid) || parentPid < 1) {
    throw new Error("parentPid must be a positive integer");
  }
  if (!targetCwd.startsWith("/")) {
    throw new Error("targetCwd must be absolute");
  }
  if (!launcher) {
    throw new Error("launcher is required");
  }

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
    ["-c", script, "pi-flash-handoff", String(parentPid), targetCwd, launcher, ...launcherArgs],
    { cwd: targetCwd, env, stdio: "inherit", detached: false },
  );
  child.unref();
  return child;
}
