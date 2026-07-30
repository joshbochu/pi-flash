import { describe, expect, it } from "vitest";

import { runCommand } from "../src/process.js";

describe("runCommand", () => {
  it("passes literal arguments without a shell", async () => {
    const result = await runCommand(process.execPath, ["-e", "console.log(process.argv[1])", "value with $; metacharacters"]);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("value with $; metacharacters");
  });

  it("captures non-zero results", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stderr.write('nope'); process.exit(7)"]);

    expect(result.code).toBe(7);
    expect(result.stderr).toBe("nope");
  });
});
