import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const root = new URL("..", import.meta.url).pathname;
const extensionPath = join(root, "dist/index.js");
const workerPath = join(root, "dist/background-worker.mjs");

test("Pi's extension loader imports the bundled extension", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "pi-flash-dist-extension-"));
  try {
    const loaded = await discoverAndLoadExtensions([extensionPath], root, agentDirectory);

    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
  } finally {
    await rm(agentDirectory, { recursive: true, force: true });
  }
});

test("the bundled worker is directly importable JavaScript", async () => {
  const worker = await import(pathToFileURL(workerPath).href);

  assert.equal(typeof worker.executeBackgroundJob, "function");
  assert.equal(typeof worker.main, "function");
});

test("the bundled worker runs as a standalone entry point", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "pi-flash-dist-worker-"));
  try {
    const child = spawn(process.execPath, [workerPath], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
      stdio: "ignore",
    });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
    });
  } finally {
    await rm(agentDirectory, { recursive: true, force: true });
  }
});
