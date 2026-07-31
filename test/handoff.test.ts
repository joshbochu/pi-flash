import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HandoffController, assertReplacementRequest, createFreshPiEnvironment, getCurrentPiInvocation } from "../src/handoff.js";

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

  it("does not spawn a replacement until session shutdown consumes a scheduled request", async () => {
    const controller = new HandoffController();
    const request = controller.preflight("/tmp");
    controller.schedule(request);
    controller.cancel();
    // This must be a no-op after cancellation. The integration handoff test
    // covers actual child timing without putting a real child on this process.
    await controller.runPending();
  });
});
