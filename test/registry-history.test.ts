import { appendFile, mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { appendHistory, getHistoryPath, readHistory, recordCreatedWorktree } from "../src/history.js";
import { getRegistryPath, parseRegistry, readRegistry, registerWorktree, updateWorktreeRecord } from "../src/registry.js";

const directories: string[] = [];

describe("worktree registry and history", () => {
  it("records a created worktree before handoff and preserves private, parseable state", async () => {
    const sandbox = await createSandbox();
    const record = await registerWorktree(repository, workspace, { ...sandbox.options, now: () => new Date("2026-07-30T12:00:00.000Z"), id: () => id });
    await recordCreatedWorktree(record, repository, workspace, { ...sandbox.options, now: () => new Date("2026-07-30T12:00:01.000Z") });

    expect(await readRegistry(sandbox.options)).toEqual({ version: 1, worktrees: [record] });
    expect(await readHistory(sandbox.options)).toEqual([
      expect.objectContaining({ event: "worktree-created", metadata: expect.objectContaining({ id, repo: "acme/billing", stale: false }) }),
    ]);
    expect((await stat(getRegistryPath(sandbox.options))).mode & 0o777).toBe(0o600);
    expect((await stat(getHistoryPath(sandbox.options))).mode & 0o777).toBe(0o600);
    expect(await readFile(getHistoryPath(sandbox.options), "utf8")).not.toContain("https://");
  });

  it("records stale fallback separately and supports guarded record updates", async () => {
    const sandbox = await createSandbox();
    const staleWorkspace = { ...workspace, stale: true, attempts: 3, lastFetchedAt: "2026-07-29T12:00:00.000Z" };
    const record = await registerWorktree(repository, staleWorkspace, { ...sandbox.options, id: () => id });
    await recordCreatedWorktree(record, repository, staleWorkspace, sandbox.options);
    const updated = await updateWorktreeRecord(id, (current) => ({ ...current, status: "parked" }), sandbox.options);
    expect(updated.status).toBe("parked");
    expect((await readHistory(sandbox.options)).map((entry) => entry.event)).toEqual(["worktree-created", "stale-fallback"]);
  });

  it("rejects duplicate worktree paths and malformed registry state", async () => {
    const sandbox = await createSandbox();
    await registerWorktree(repository, workspace, { ...sandbox.options, id: () => id });
    await expect(registerWorktree(repository, workspace, { ...sandbox.options, id: () => "123e4567-e89b-42d3-a456-426614174001" })).rejects.toThrow("already tracks");
    expect(() => parseRegistry({ version: 1, worktrees: [{ id, path: "/tmp/a" }] })).toThrow("repo is invalid");
  });

  it("fails closed on malformed history lines", async () => {
    const sandbox = await createSandbox();
    await appendHistory({ version: 1, at: "2026-07-30T12:00:00.000Z", event: "failure", metadata: { code: "network" } }, sandbox.options);
    await mkdir(join(sandbox.options.agentDirectory, "pi-flash"), { recursive: true });
    await appendFile(getHistoryPath(sandbox.options), "{bad}\n");
    await expect(readHistory(sandbox.options)).rejects.toThrow("line 2");
  });
});

const id = "123e4567-e89b-42d3-a456-426614174000";
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

async function createSandbox(): Promise<{ options: { homeDirectory: string; agentDirectory: string } }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-flash-registry-"));
  directories.push(directory);
  const homeDirectory = join(directory, "home");
  const agentDirectory = join(homeDirectory, ".pi", "agent");
  await mkdir(agentDirectory, { recursive: true });
  return { options: { homeDirectory, agentDirectory } };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
