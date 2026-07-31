import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const parentFixture = join(root, "test/fixtures/handoff-parent.mjs");
const targetFixture = join(root, "test/fixtures/handoff-target.mjs");

async function waitForFile(path, timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

test("handoff keeps its parent alive while launching in the literal target cwd", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-flash-handoff-"));
  const target = join(temp, "target with $dollar;semicolon");
  const output = join(temp, "target.jsonl");
  const eventLog = join(temp, "events.log");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(target);

  const parent = spawn(process.execPath, [parentFixture, target, process.execPath, output, targetFixture], {
    cwd: temp,
    env: { ...process.env, PI_FLASH_TEST_EVENT_LOG: eventLog },
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    parent.once("error", reject);
    parent.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`parent exited ${code}`))));
  });

  await waitForFile(output);
  const targetRun = JSON.parse((await readFile(output, "utf8")).trim());
  const events = (await readFile(eventLog, "utf8")).trim().split("\n");
  const replacementStart = Number(events[0].split(" ")[1]);
  const parentExit = Number(events[1].split(" ")[1]);

  assert.equal(targetRun.cwd, await realpath(target));
  assert.ok(targetRun.at >= replacementStart, "replacement began after the shutdown handler started it");
  assert.ok(parentExit >= targetRun.at, "initiating process remained alive until the replacement exited");
});
