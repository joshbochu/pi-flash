import { describe, expect, it, vi } from "vitest";

import piFlash from "../src/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

describe("Pi Flash extension", () => {
  it("registers the flash user command", () => {
    const registerCommand = vi.fn();
    piFlash({ registerCommand } as unknown as ExtensionAPI);

    expect(registerCommand).toHaveBeenCalledWith(
      "flash",
      expect.objectContaining({ description: expect.stringContaining("isolated Git worktree") }),
    );
  });
});
