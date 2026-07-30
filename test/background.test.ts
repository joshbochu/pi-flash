import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  enqueueBackgroundJob,
  readBackgroundEvents,
  runBackgroundWorker,
  scheduleRepositoryRefresh,
  type BackgroundJobKind,
} from "../src/background.js";

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const temporaryRoots: string[] = [];

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("background jobs", () => {
  it("coalesces repeated pending requests", async () => {
    const agentDirectory = await sandbox();
    const first = await enqueueBackgroundJob("refresh-index", {
      agentDirectory,
      id: () => firstId,
    });
    const second = await enqueueBackgroundJob("refresh-index", {
      agentDirectory,
      id: () => secondId,
    });

    expect(first.coalesced).toBe(false);
    expect(second.coalesced).toBe(true);
    expect(second.request.id).toBe(firstId);
  });

  it("drains each job kind under one worker and records durable outcomes", async () => {
    const agentDirectory = await sandbox();
    const ids = [firstId, secondId][Symbol.iterator]();
    await enqueueBackgroundJob("refresh-index", { agentDirectory, id: () => ids.next().value! });
    await enqueueBackgroundJob("automatic-cleanup", { agentDirectory, id: () => ids.next().value! });
    const executed: BackgroundJobKind[] = [];

    const owned = await runBackgroundWorker({
      agentDirectory,
      executeJob: async (request) => {
        executed.push(request.kind);
        return request.kind === "refresh-index"
          ? { status: "succeeded", summary: "refreshed" }
          : { status: "skipped", summary: "disabled" };
      },
    });

    expect(owned).toBe(true);
    expect(executed).toEqual(["refresh-index", "automatic-cleanup"]);
    expect(await readBackgroundEvents({ agentDirectory })).toMatchObject([
      { id: firstId, kind: "refresh-index", status: "succeeded", summary: "refreshed" },
      { id: secondId, kind: "automatic-cleanup", status: "skipped", summary: "disabled" },
    ]);
  });

  it("allows only one live worker and coalesces a request already in progress", async () => {
    const agentDirectory = await sandbox();
    await enqueueBackgroundJob("refresh-index", { agentDirectory, id: () => firstId });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = runBackgroundWorker({
      agentDirectory,
      executeJob: async () => {
        started();
        await blocked;
        return { status: "succeeded", summary: "done" };
      },
    });
    await didStart;

    const duplicate = await runBackgroundWorker({
      agentDirectory,
      executeJob: async () => ({ status: "succeeded", summary: "must not run" }),
    });
    const enqueued = await enqueueBackgroundJob("refresh-index", {
      agentDirectory,
      id: () => secondId,
    });
    release();

    expect(duplicate).toBe(false);
    expect(enqueued.active).toBe(true);
    expect(enqueued.coalesced).toBe(true);
    expect(enqueued.request.id).toBe(firstId);
    await expect(first).resolves.toBe(true);
    expect(await readBackgroundEvents({ agentDirectory })).toHaveLength(1);
  });

  it("records failures and consumes the failed request", async () => {
    const agentDirectory = await sandbox();
    await enqueueBackgroundJob("automatic-cleanup", { agentDirectory, id: () => firstId });

    await runBackgroundWorker({
      agentDirectory,
      executeJob: async () => {
        throw new Error("network credentials unavailable");
      },
    });
    const next = await enqueueBackgroundJob("automatic-cleanup", {
      agentDirectory,
      id: () => secondId,
    });

    expect(await readBackgroundEvents({ agentDirectory })).toMatchObject([
      { id: firstId, status: "failed", summary: "network credentials unavailable" },
    ]);
    expect(next.coalesced).toBe(false);
    expect(next.request.id).toBe(secondId);
  });

  it("reclaims a stale heartbeat even if its PID has been reused", async () => {
    const agentDirectory = await sandbox();
    await enqueueBackgroundJob("refresh-index", { agentDirectory, id: () => firstId });
    const lockDirectory = join(agentDirectory, "pi-flash", "background", "worker.lock");
    await mkdir(lockDirectory, { recursive: true });
    const stale = new Date(Date.now() - 120_000).toISOString();
    await writeFile(join(lockDirectory, "owner.json"), JSON.stringify({
      version: 1,
      token: secondId,
      pid: process.pid,
      startedAt: stale,
      heartbeatAt: stale,
    }));
    let executions = 0;

    const owned = await runBackgroundWorker({
      agentDirectory,
      executeJob: async () => {
        executions += 1;
        return { status: "succeeded", summary: "recovered" };
      },
    });

    expect(owned).toBe(true);
    expect(executions).toBe(1);
    expect(await readBackgroundEvents({ agentDirectory })).toMatchObject([
      { id: firstId, status: "succeeded", summary: "recovered" },
    ]);
  });

  it("runs the source worker independently of the scheduling process", async () => {
    const agentDirectory = await sandbox();
    const scheduled = await scheduleRepositoryRefresh({
      agentDirectory,
      id: () => firstId,
    });

    expect(scheduled.workerStarted).toBe(true);
    const events = await waitForEvents(agentDirectory);
    expect(events).toMatchObject([
      { id: firstId, kind: "refresh-index", status: "skipped", summary: "Pi Flash is not configured." },
    ]);
    await waitForWorkerIdle(agentDirectory);
  });
});

async function sandbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-flash-background-"));
  temporaryRoots.push(root);
  return join(root, "agent");
}

async function waitForEvents(agentDirectory: string) {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const events = await readBackgroundEvents({ agentDirectory });
    if (events.length > 0) return events;
    if (Date.now() >= deadline) throw new Error("background worker did not record an outcome");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForWorkerIdle(agentDirectory: string): Promise<void> {
  const lock = join(agentDirectory, "pi-flash", "background", "worker.lock");
  const deadline = Date.now() + 8_000;
  for (;;) {
    try {
      await stat(lock);
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error("background worker did not release its lock");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
