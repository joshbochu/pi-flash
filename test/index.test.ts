import { describe, expect, it, vi } from "vitest";

import piFlash, { formatHistoryEntry, isCleanupCommand } from "../src/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

describe("Pi Flash extension", () => {
  it("registers the flash user command", () => {
    const registerCommand = vi.fn();
    const on = vi.fn();
    piFlash({ registerCommand, on } as unknown as ExtensionAPI);

    expect(registerCommand).toHaveBeenCalledWith(
      "flash",
      expect.objectContaining({ description: expect.stringContaining("isolated Git worktree") }),
    );
    expect(on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("reserves only the clean command namespace", () => {
    expect(isCleanupCommand("clean")).toBe(true);
    expect(isCleanupCommand("clean enable")).toBe(true);
    expect(isCleanupCommand("cleanroom")).toBe(false);
    expect(isCleanupCommand("clean-api")).toBe(false);
  });

  it("shows recovery commits in history summaries", () => {
    expect(formatHistoryEntry({
      version: 1,
      at: "2026-07-30T00:00:00.000Z",
      event: "removed",
      metadata: {
        repo: "acme/billing",
        branch: "josh/calm-wren",
        commit: "1234567890abcdef1234567890abcdef12345678",
      },
    })).toContain("josh/calm-wren) @ 1234567890ab");
  });
});
