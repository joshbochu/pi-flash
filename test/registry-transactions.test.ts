import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  advanceCleanupOperation,
  claimWorktreeForCleanup,
  completeCleanupRemoval,
  listIncompleteCleanupOperations,
  parseRegistry,
  readRegistry,
  recoverStaleWorktreeLeases,
  registerWorktree,
  releaseCleanupClaim,
  setWorktreeLeaseForPath,
  validateCleanupClaim,
} from "../src/registry.js";

const directories: string[] = [];

describe("registry transactions", () => {
  it("serializes concurrent writers without losing registrations", async () => {
    const sandbox = await createSandbox();
    const count = 32;

    await Promise.all(Array.from({ length: count }, (_, index) => {
      const suffix = String(index).padStart(6, "0");
      return registerWorktree(repository, {
        ...workspace,
        worktreePath: `/tmp/workspace/worktrees/acme/billing/pet-${suffix}`,
        branch: `josh/pet-${suffix}`,
      }, {
        ...sandbox.options,
        id: () => uuid(index),
        processIdentity: async () => "test-process",
        lockRetryMs: 1,
      });
    }));

    const registry = await readRegistry(sandbox.options);
    expect(registry.worktrees).toHaveLength(count);
    expect(new Set(registry.worktrees.map((record) => record.id)).size).toBe(count);
    expect(new Set(registry.worktrees.map((record) => record.path)).size).toBe(count);
  });

  it("serializes registrations from independent Node processes", async () => {
    const sandbox = await createSandbox();
    const childCount = 12;
    const loader = join(process.cwd(), "src", "typescript-loader.mjs");
    const child = `
      import { registerWorktree } from "./src/registry.ts";
      const input = JSON.parse(process.argv[1]);
      await registerWorktree(input.repository, input.workspace, {
        homeDirectory: input.homeDirectory,
        agentDirectory: input.agentDirectory,
        id: () => input.id,
        lockRetryMs: 1
      });
    `;

    await Promise.all(Array.from({ length: childCount }, (_, index) => {
      const suffix = String(index).padStart(6, "0");
      const input = {
        ...sandbox.options,
        id: uuid(index),
        repository,
        workspace: {
          ...workspace,
          worktreePath: `/tmp/workspace/worktrees/acme/billing/child-${suffix}`,
          branch: `josh/child-${suffix}`,
        },
      };
      return promisify(execFile)(process.execPath, [
        "--no-warnings",
        "--experimental-strip-types",
        "--loader",
        loader,
        "--input-type=module",
        "-e",
        child,
        JSON.stringify(input),
      ], { cwd: process.cwd(), timeout: 20_000 });
    }));

    const registry = await readRegistry(sandbox.options);
    expect(registry.worktrees).toHaveLength(childCount);
    expect(new Set(registry.worktrees.map((record) => record.id)).size).toBe(childCount);
  });

  it("atomically claims a fresh record and refuses a live session", async () => {
    const sandbox = await createSandbox();
    const record = await register(sandbox.options);
    const leasePid = 4242;
    const identity = (pid: number) => pid === leasePid ? "lease-start-a" : "test-process";
    await setWorktreeLeaseForPath(record.path, leasePid, {
      ...sandbox.options,
      isProcessAlive: () => true,
      processIdentity: async (pid) => identity(pid),
    });

    const blocked = await claimWorktreeForCleanup(record.id, {
      ...sandbox.options,
      isProcessAlive: () => true,
      processIdentity: async (pid) => identity(pid),
    });
    expect(blocked).toEqual({ claimed: false, reason: "active-session" });
    expect((await readRegistry(sandbox.options)).operations).toEqual([]);

    const operationId = uuid(1);
    const claimed = await claimWorktreeForCleanup(record.id, {
      ...sandbox.options,
      id: () => operationId,
      isProcessAlive: () => true,
      processIdentity: async () => "lease-start-b",
    });
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) throw new Error("expected cleanup claim");
    expect(claimed.record).toMatchObject({ status: "parked", activeLease: null, barePath: workspace.barePath });
    expect(claimed.operation).toMatchObject({ id: operationId, status: "planned", worktreeId: record.id });
    const durableClaim = { record: claimed.record, operation: claimed.operation };
    expect(await validateCleanupClaim(record.id, operationId, "planned", sandbox.options)).toEqual(durableClaim);
    expect(await listIncompleteCleanupOperations(sandbox.options)).toEqual([durableClaim]);

    expect(await releaseCleanupClaim(record.id, operationId, sandbox.options)).toMatchObject({ status: "active" });
    expect(await validateCleanupClaim(record.id, operationId, undefined, sandbox.options)).toBeNull();
    expect(await listIncompleteCleanupOperations(sandbox.options)).toEqual([]);
    expect((await readRegistry(sandbox.options)).operations[0]?.status).toBe("aborted");
  });

  it("cancels a planned cleanup when Pi starts in its worktree", async () => {
    const sandbox = await createSandbox();
    const record = await register(sandbox.options);
    const claimed = await claimWorktreeForCleanup(record.id, { ...sandbox.options, id: () => uuid(1) });
    expect(claimed.claimed).toBe(true);

    await expect(setWorktreeLeaseForPath(record.path, 4242, {
      ...sandbox.options,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
      processIdentity: async () => "lease-start",
    })).resolves.toBe(true);

    const registry = await readRegistry(sandbox.options);
    expect(registry.worktrees[0]).toMatchObject({
      status: "active",
      lastUsedAt: "2026-08-01T00:00:00.000Z",
      activeLease: { pid: 4242, processIdentity: "lease-start" },
    });
    expect(registry.operations[0]?.status).toBe("aborted");
  });

  it("cancels a cleanup that was already committed when Pi starts", async () => {
    const sandbox = await createSandbox();
    const record = await register(sandbox.options);
    const claimed = await claimWorktreeForCleanup(record.id, { ...sandbox.options, id: () => uuid(1) });
    if (!claimed.claimed) throw new Error("expected cleanup claim");
    await advanceCleanupOperation(claimed.operation.id, "committed", "b".repeat(40), sandbox.options);

    await setWorktreeLeaseForPath(record.path, 4242, {
      ...sandbox.options,
      processIdentity: async () => "lease-start",
    });

    const registry = await readRegistry(sandbox.options);
    expect(registry.worktrees[0]).toMatchObject({ status: "active", activeLease: { pid: 4242 } });
    expect(registry.operations[0]).toMatchObject({ status: "aborted", commit: "b".repeat(40) });
    expect(await listIncompleteCleanupOperations(sandbox.options)).toEqual([]);
  });

  it("holds the claim lock through removal so a new session cannot race deletion", async () => {
    const sandbox = await createSandbox();
    const record = await register(sandbox.options);
    const claimed = await claimWorktreeForCleanup(record.id, { ...sandbox.options, id: () => uuid(1) });
    if (!claimed.claimed) throw new Error("expected cleanup claim");
    await advanceCleanupOperation(claimed.operation.id, "committed", "c".repeat(40), sandbox.options);
    await advanceCleanupOperation(claimed.operation.id, "pushed", "c".repeat(40), sandbox.options);
    await advanceCleanupOperation(claimed.operation.id, "remote-verified", "c".repeat(40), sandbox.options);
    let removalStarted!: () => void;
    const started = new Promise<void>((resolve) => { removalStarted = resolve; });
    let allowRemoval!: () => void;
    const blocked = new Promise<void>((resolve) => { allowRemoval = resolve; });

    const removal = completeCleanupRemoval(record.id, claimed.operation.id, {
      ...sandbox.options,
      processIdentity: async () => "test-process",
      remove: async () => {
        removalStarted();
        await blocked;
      },
    });
    await started;
    const lease = setWorktreeLeaseForPath(record.path, 4242, {
      ...sandbox.options,
      processIdentity: async () => "lease-start",
    });
    allowRemoval();

    await expect(removal).resolves.toMatchObject({ status: "removed" });
    await expect(lease).resolves.toBe(false);
    expect((await readRegistry(sandbox.options)).worktrees[0]?.status).toBe("removed");
  });

  it("recovers dead and recycled-PID leases but fails closed for a live legacy lease", async () => {
    const sandbox = await createSandbox();
    const record = await register(sandbox.options);
    await setWorktreeLeaseForPath(record.path, 4242, {
      ...sandbox.options,
      processIdentity: async () => "old-process",
    });

    await expect(recoverStaleWorktreeLeases({
      ...sandbox.options,
      isProcessAlive: () => true,
      processIdentity: async (pid) => pid === 4242 ? "new-process" : "test-process",
    })).resolves.toBe(1);
    expect((await readRegistry(sandbox.options)).worktrees[0]?.activeLease).toBeNull();

    await setWorktreeLeaseForPath(record.path, 4242, {
      ...sandbox.options,
      processIdentity: async () => "old-process",
    });
    await expect(recoverStaleWorktreeLeases({
      ...sandbox.options,
      isProcessAlive: (pid) => pid !== 4242,
      processIdentity: async () => "old-process",
    })).resolves.toBe(1);
    expect((await readRegistry(sandbox.options)).worktrees[0]?.activeLease).toBeNull();

    const legacy = parseRegistry({
      version: 1,
      worktrees: [{
        ...record,
        activeLease: { pid: 4242, heartbeatAt: "2026-07-01T00:00:00.000Z" },
      }],
      operations: [],
    });
    expect(legacy.worktrees[0]?.activeLease).toEqual({ pid: 4242, heartbeatAt: "2026-07-01T00:00:00.000Z" });
  });

  it("migrates the canonical bare path for a legacy registry record", async () => {
    const sandbox = await createSandbox();
    const record = await register(sandbox.options);
    const { barePath: _barePath, ...legacyRecord } = record;

    expect(parseRegistry({ version: 1, worktrees: [legacyRecord], operations: [] }).worktrees[0]?.barePath)
      .toBe(workspace.barePath);
  });

  it("does not create registry state when setting a lease outside a managed worktree", async () => {
    const sandbox = await createSandbox();
    await expect(setWorktreeLeaseForPath("/tmp/not-managed", process.pid, {
      ...sandbox.options,
      processIdentity: async () => "test-process",
    })).resolves.toBe(false);
    expect(await readRegistry(sandbox.options)).toEqual({ version: 1, worktrees: [], operations: [] });
  });
});

const repository = { nameWithOwner: "acme/billing", owner: "acme", name: "billing", defaultBranch: "main", description: "" };
const workspace = {
  barePath: "/tmp/workspace/.flash/repos/acme/billing.git",
  worktreePath: "/tmp/workspace/worktrees/acme/billing/brisk-otter-000001",
  branch: "josh/brisk-otter-000001",
  baseSha: "a".repeat(40),
  stale: false,
  attempts: 1,
  lastFetchedAt: "2026-07-30T11:00:00.000Z",
};

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function register(options: { homeDirectory: string; agentDirectory: string }) {
  return registerWorktree(repository, workspace, {
    ...options,
    id: () => uuid(0),
    now: () => new Date("2026-07-01T00:00:00.000Z"),
    processIdentity: async () => "test-process",
  });
}

async function createSandbox(): Promise<{ options: { homeDirectory: string; agentDirectory: string } }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-flash-registry-transactions-"));
  directories.push(directory);
  const homeDirectory = join(directory, "home");
  const agentDirectory = join(homeDirectory, ".pi", "agent");
  await mkdir(agentDirectory, { recursive: true });
  return { options: { homeDirectory, agentDirectory } };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
