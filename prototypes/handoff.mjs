/** Replace the current foreground process without introducing a parent chain. */
export function replaceCurrentProcess({ targetCwd, launcher, launcherArgs = [], env = process.env }) {
  if (!targetCwd.startsWith("/")) throw new Error("targetCwd must be absolute");
  if (!launcher) throw new Error("launcher is required");
  if (!process.execve) throw new Error("process.execve is unavailable on this platform");

  process.chdir(targetCwd);
  process.execve(launcher, [launcher, ...launcherArgs], { ...env, PWD: targetCwd });
}
