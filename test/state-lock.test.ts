import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { withFileLock } from "../src/state-lock.js";

const directories: string[] = [];

describe("interprocess state lock", () => {
  it.each([
    ["dead process", false, "old-process"],
    ["recycled pid", true, "new-process"],
  ])("recovers a %s owner and removes its orphan owner file", async (_label, alive, identity) => {
    const root = await mkdtemp(join(tmpdir(), "pi-flash-lock-"));
    directories.push(root);
    const lockPath = join(root, "state.lock");
    const loader = join(process.cwd(), "src", "typescript-loader.mjs");
    const child = [
      "import { withFileLock } from './src/state-lock.ts';",
      "await withFileLock(process.argv[1], async () => process.exit(0),",
      "  { processIdentity: async () => 'old-process' });",
    ].join("\n");
    await promisify(execFile)(process.execPath, [
      "--no-warnings",
      "--experimental-strip-types",
      "--loader",
      loader,
      "--input-type=module",
      "-e",
      child,
      lockPath,
    ], { cwd: process.cwd(), timeout: 10_000 });

    await expect(withFileLock(lockPath, async () => "recovered", {
      isProcessAlive: () => alive,
      processIdentity: async () => identity,
      lockRetryMs: 1,
    })).resolves.toBe("recovered");
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(dirname(lockPath))).filter((name) => name.endsWith(".owner"))).toEqual([]);
  });
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
