import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  HandoffController,
  assertReplacementRequest,
  createFreshPiEnvironment,
  getCurrentPiInvocation,
  replaceCurrentProcess,
} from "../src/handoff.js";

describe("Pi replacement handoff", () => {
  it("uses the currently running script when it is a real file", () => {
    const currentScript = fileURLToPath(import.meta.url);
    expect(getCurrentPiInvocation(process.execPath, currentScript)).toEqual({ command: process.execPath, args: [currentScript] });
  });

  it("falls back to the pi command for a generic runtime without a usable script", () => {
    expect(getCurrentPiInvocation("/usr/local/bin/node", "/$bunfs/root/virtual.js")).toEqual({ command: "pi", args: [] });
  });

  it("preserves global configuration while removing explicit session selection", () => {
    expect(createFreshPiEnvironment({
      PI_CODING_AGENT_DIR: "/tmp/pi-agent",
      PI_CODING_AGENT_SESSION_DIR: "/tmp/pi-sessions",
      PI_SESSION_FILE: "/tmp/old.jsonl",
      PI_SESSION_ID: "old-session",
      OTHER: "preserved",
    })).toEqual({
      PI_CODING_AGENT_DIR: "/tmp/pi-agent",
      PI_CODING_AGENT_SESSION_DIR: "/tmp/pi-sessions",
      OTHER: "preserved",
    });
  });

  it("rejects invalid handoff requests before a parent session is shut down", () => {
    expect(() => assertReplacementRequest({ targetCwd: "relative", invocation: { command: "pi", args: [] } })).toThrow("absolute");
    expect(() => assertReplacementRequest({ targetCwd: "/tmp", invocation: { command: "", args: [] } })).toThrow("determine");
  });

  it("changes directory and execs the replacement with a fresh session environment", () => {
    const replaced = new Error("execve replaced the test process");
    const changeDirectory = vi.fn();
    const execve = vi.fn((_file: string, _args?: readonly string[], _env?: NodeJS.ProcessEnv): never => {
      throw replaced;
    });

    expect(() => replaceCurrentProcess({
      targetCwd: "/tmp/next worktree",
      invocation: { command: process.execPath, args: ["/opt/pi/cli.js"] },
      env: { PATH: process.env.PATH, PI_SESSION_ID: "old", OTHER: "kept" },
    }, { changeDirectory, execve })).toThrow(replaced);

    expect(changeDirectory).toHaveBeenCalledWith("/tmp/next worktree");
    expect(execve).toHaveBeenCalledWith(
      process.execPath,
      [process.execPath, "/opt/pi/cli.js"],
      expect.objectContaining({ PWD: "/tmp/next worktree", OTHER: "kept" }),
    );
    expect(execve.mock.calls[0]?.[2]).not.toHaveProperty("PI_SESSION_ID");
  });

  it("does not arm a replacement after a scheduled request is cancelled", async () => {
    const controller = new HandoffController();
    const request = controller.preflight("/tmp");
    controller.schedule(request);
    controller.cancel();
    await controller.completePendingReplacement();
  });
});
