import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cleanEligibleWorktree, reconcileIncompleteCleanup, scanCleanup } from "../src/cleanup.js";
import { createDefaultConfig } from "../src/config.js";
import { prepareWorkspace } from "../src/git-workspace.js";
import { runCommand } from "../src/process.js";
import {
  advanceCleanupOperation,
  claimWorktreeForCleanup,
  readRegistry,
  registerWorktree,
  setWorktreeLeaseForPath,
} from "../src/registry.js";

const directories: string[] = [];
const repo = { nameWithOwner: "acme/billing", owner: "acme", name: "billing", defaultBranch: "main", description: "" };

describe("conservative cleanup", () => {
  it("reports default-policy untracked files without changing the worktree", async () => {
    const sandbox = await createSandbox(); const config = configuration(sandbox.workspace);
    const workspace = await prepareWorkspace(repo, config, "josh", { remoteUrl: sandbox.url, createPetName: () => "brisk-otter-000001" });
    const record = await registerWorktree(repo, workspace, { agentDirectory: sandbox.agent, now: () => new Date("2026-07-01T00:00:00.000Z") });
    await writeFile(join(workspace.worktreePath, "local.txt"), "keep");
    const proposals = await withAgent(sandbox.agent, () => scanCleanup(config, Date.parse("2026-07-30T00:00:00.000Z")));
    expect(proposals).toEqual([expect.objectContaining({ record: expect.objectContaining({ id: record.id }), eligible: false, reasons: expect.arrayContaining(["untracked-files"]) })]);
    await expect(access(join(workspace.worktreePath, "local.txt"))).resolves.toBeUndefined();
  });

  it("pushes, verifies, records, and only then removes an eligible worktree", async () => {
    const sandbox = await createSandbox(); const config = configuration(sandbox.workspace);
    const workspace = await prepareWorkspace(repo, config, "josh", { remoteUrl: sandbox.url, createPetName: () => "calm-wren-000002" });
    const record = await registerWorktree(repo, workspace, { agentDirectory: sandbox.agent, now: () => new Date("2026-07-01T00:00:00.000Z") });
    await withAgent(sandbox.agent, () => cleanEligibleWorktree(record, config));
    await expect(access(workspace.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    const remote = await command("git", ["--git-dir", sandbox.origin, "show-ref", "--verify", `refs/heads/${workspace.branch}`]);
    expect(remote.stdout).toContain(workspace.baseSha);
    const registry = await readRegistry({ agentDirectory: sandbox.agent });
    expect(registry.worktrees[0]?.status).toBe("removed");
    expect(registry.operations[0]).toMatchObject({ status: "recorded", commit: workspace.baseSha });
  });

  it("refuses a stale cleanup candidate after a Pi session acquires its lease", async () => {
    const sandbox = await createSandbox(); const config = configuration(sandbox.workspace);
    const workspace = await prepareWorkspace(repo, config, "josh", { remoteUrl: sandbox.url, createPetName: () => "quiet-raven-000003" });
    const record = await registerWorktree(repo, workspace, { agentDirectory: sandbox.agent, now: () => new Date("2026-07-01T00:00:00.000Z") });
    await withAgent(sandbox.agent, async () => {
      expect((await scanCleanup(config, Date.parse("2026-07-30T00:00:00.000Z")))[0]?.eligible).toBe(true);
      await setWorktreeLeaseForPath(workspace.worktreePath, process.pid);
      await expect(cleanEligibleWorktree(record, config)).rejects.toThrow("active-session");
    });
    await expect(access(workspace.worktreePath)).resolves.toBeUndefined();
    const registry = await readRegistry({ agentDirectory: sandbox.agent });
    expect(registry.worktrees[0]).toMatchObject({ status: "active", activeLease: { pid: process.pid } });
    expect(registry.operations).toEqual([]);
  });

  it("resumes an interrupted committed operation and removes only after verification", async () => {
    const sandbox = await createSandbox(); const config = configuration(sandbox.workspace);
    const workspace = await prepareWorkspace(repo, config, "josh", { remoteUrl: sandbox.url, createPetName: () => "swift-falcon-000004" });
    const record = await registerWorktree(repo, workspace, { agentDirectory: sandbox.agent, now: () => new Date("2026-07-01T00:00:00.000Z") });
    await withAgent(sandbox.agent, async () => {
      const claim = await claimWorktreeForCleanup(record.id);
      if (!claim.claimed) throw new Error("expected cleanup claim");
      await advanceCleanupOperation(claim.operation.id, "committed", workspace.baseSha);
      await expect(reconcileIncompleteCleanup(config)).resolves.toMatchObject({ reconciled: 1, failures: [] });
    });
    await expect(access(workspace.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readRegistry({ agentDirectory: sandbox.agent })).operations[0]).toMatchObject({
      status: "recorded",
      commit: workspace.baseSha,
    });
  });

  it("reconciles a crash after Git removed the worktree but before registry commit", async () => {
    const sandbox = await createSandbox(); const config = configuration(sandbox.workspace);
    const workspace = await prepareWorkspace(repo, config, "josh", { remoteUrl: sandbox.url, createPetName: () => "nimble-panda-000007" });
    const record = await registerWorktree(repo, workspace, { agentDirectory: sandbox.agent, now: () => new Date("2026-07-01T00:00:00.000Z") });
    await withAgent(sandbox.agent, async () => {
      const claim = await claimWorktreeForCleanup(record.id);
      if (!claim.claimed) throw new Error("expected cleanup claim");
      await advanceCleanupOperation(claim.operation.id, "committed", workspace.baseSha);
      await command("git", ["-C", workspace.barePath, "push", "origin", `${workspace.baseSha}:refs/heads/${workspace.branch}`]);
      await advanceCleanupOperation(claim.operation.id, "pushed", workspace.baseSha);
      await advanceCleanupOperation(claim.operation.id, "remote-verified", workspace.baseSha);
      await command("git", ["-C", workspace.barePath, "worktree", "remove", workspace.worktreePath]);

      await expect(reconcileIncompleteCleanup(config)).resolves.toMatchObject({ reconciled: 1, failures: [] });
    });
    expect((await readRegistry({ agentDirectory: sandbox.agent })).operations[0]?.status).toBe("recorded");
  });

  it("uses the recorded managed layout after the configured workspace root changes", async () => {
    const sandbox = await createSandbox(); const config = configuration(sandbox.workspace);
    const workspace = await prepareWorkspace(repo, config, "josh", { remoteUrl: sandbox.url, createPetName: () => "gentle-yak-000005" });
    const record = await registerWorktree(repo, workspace, { agentDirectory: sandbox.agent, now: () => new Date("2026-07-01T00:00:00.000Z") });
    config.workspaceRoot = join(sandbox.workspace, "new-root");
    await withAgent(sandbox.agent, () => cleanEligibleWorktree(record, config));
    await expect(access(workspace.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats ignored files independently from the untracked-file policy", async () => {
    const sandbox = await createSandbox(); const config = configuration(sandbox.workspace);
    config.cleanup.ignoredFiles = "discard";
    const workspace = await prepareWorkspace(repo, config, "josh", { remoteUrl: sandbox.url, createPetName: () => "lucky-gecko-000006" });
    const record = await registerWorktree(repo, workspace, { agentDirectory: sandbox.agent, now: () => new Date("2026-07-01T00:00:00.000Z") });
    const exclude = await command("git", ["-C", workspace.worktreePath, "rev-parse", "--git-path", "info/exclude"]);
    await writeFile(exclude.stdout.trim(), "ignored.log\n");
    await writeFile(join(workspace.worktreePath, "ignored.log"), "discard me");

    const proposals = await withAgent(sandbox.agent, () => scanCleanup(config, Date.parse("2026-07-30T00:00:00.000Z")));
    expect(proposals[0]).toMatchObject({ eligible: true, ignored: 1, untracked: 0 });
    await withAgent(sandbox.agent, () => cleanEligibleWorktree(record, config));
    await expect(access(workspace.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function configuration(workspace: string) { const config = createDefaultConfig({ homeDirectory: workspace }); config.workspaceRoot = workspace; return config; }
async function createSandbox() { const root = await mkdtemp(join(tmpdir(), "pi-flash-clean-")); directories.push(root); const origin = join(root, "origin.git"), source = join(root, "source"), workspace = join(root, "workspace"), agent = join(root, "agent"); await mkdir(source, { recursive: true }); await command("git", ["init", "--bare", origin]); await command("git", ["init", source]); await command("git", ["-C", source, "config", "user.name", "Test"]); await command("git", ["-C", source, "config", "user.email", "test@example.invalid"]); await writeFile(join(source, "README.md"), "base\n"); await command("git", ["-C", source, "add", "."]); await command("git", ["-C", source, "commit", "-m", "base"]); await command("git", ["-C", source, "branch", "-M", "main"]); await command("git", ["-C", source, "remote", "add", "origin", `file://${origin}`]); await command("git", ["-C", source, "push", "origin", "main"]); return { origin, workspace, agent, url: `file://${origin}` }; }
async function command(name: string, args: string[]) { const result = await runCommand(name, args, { timeoutMs: 30_000 }); if (result.code !== 0) throw new Error(result.stderr); return result; }
async function withAgent<T>(agent: string, operation: () => Promise<T>): Promise<T> { const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent; try { return await operation(); } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; } }
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
