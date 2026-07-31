import { spawn } from "node:child_process";

/**
 * Start a replacement process while the parent keeps the foreground job alive.
 *
 * The caller must await the returned child before allowing the parent to exit.
 */
export function startReplacement({ targetCwd, launcher, launcherArgs = [], env = process.env }) {
  if (!targetCwd.startsWith("/")) {
    throw new Error("targetCwd must be absolute");
  }
  if (!launcher) {
    throw new Error("launcher is required");
  }

  const child = spawn(
    launcher,
    launcherArgs,
    { cwd: targetCwd, env, stdio: "inherit", detached: false },
  );
  return child;
}
