import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const loader = join(root, "src/typescript-loader.mjs");
const parentFixture = join(root, "test/fixtures/handoff-parent.mjs");
const targetFixture = join(root, "test/fixtures/handoff-target.mjs");

test("handoff replaces its process in the literal target cwd", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-flash-handoff-"));
  const target = join(temp, "target with $dollar;semicolon");
  const output = join(temp, "target.jsonl");
  await mkdir(target);

  const replacement = spawn(process.execPath, [
    "--no-warnings",
    "--experimental-transform-types",
    "--experimental-loader",
    pathToFileURL(loader).href,
    parentFixture,
    target,
    process.execPath,
    output,
    targetFixture,
  ], {
    cwd: temp,
    env: { ...process.env, PI_SESSION_ID: "must-not-survive" },
    stdio: "ignore",
  });
  const originalPid = replacement.pid;
  await new Promise((resolve, reject) => {
    replacement.once("error", reject);
    replacement.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`replacement exited ${code}`))));
  });

  const targetRun = JSON.parse((await readFile(output, "utf8")).trim());
  assert.equal(targetRun.cwd, await realpath(target));
  assert.equal(targetRun.pid, originalPid, "execve preserves the foreground process PID");
  assert.deepEqual(targetRun.argv, [output]);
});
