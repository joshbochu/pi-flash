import { realpath, stat } from "node:fs/promises";
import { relative } from "node:path";

import type { Config } from "./config.js";
import { getBareRepositoryPath } from "./git-workspace.js";
import { appendHistory } from "./history.js";
import { runCommand } from "./process.js";
import { advanceCleanupOperation, createCleanupOperation, readRegistry, updateWorktreeRecord, type WorktreeRecord } from "./registry.js";

export interface CleanupProposal { record: WorktreeRecord; eligible: boolean; reasons: string[]; trackedChanges: boolean; untracked: number; ignored: number; }

/** Scans only Pi Flash registry entries; it never walks an arbitrary workspace. */
export async function scanCleanup(config: Config, now = Date.now()): Promise<CleanupProposal[]> {
  const registry = await readRegistry();
  return Promise.all(registry.worktrees.filter((record) => record.status === "active").map((record) => inspectWorktree(record, config, now)));
}

export async function cleanEligibleWorktree(record: WorktreeRecord, config: Config): Promise<void> {
  const proposal = await inspectWorktree(record, config, Date.now());
  if (!proposal.eligible) {
    await appendHistory({ version: 1, at: new Date().toISOString(), event: "cleanup-skipped", metadata: { id: record.id, repo: record.repo, reason: proposal.reasons.join(",") } });
    throw new Error(`This worktree is not safe to clean: ${proposal.reasons.join(", ")}.`);
  }
  const operation = await createCleanupOperation(record);
  let commit: string | null = null;
  try {
    const status = await git(record.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]);
    const parsed = parseStatus(status.stdout);
    if (parsed.untracked > 0 && config.cleanup.untrackedFiles === "include-unignored") {
      await requireGit(record.path, ["add", "-A", "--", "."], "Could not stage non-ignored worktree changes.");
    } else {
      await requireGit(record.path, ["add", "-u"], "Could not stage tracked worktree changes.");
    }
    const staged = await git(record.path, ["diff", "--cached", "--quiet"]);
    if (staged.code === 1) await requireGit(record.path, ["commit", "-m", `pi-flash: park ${new Date().toISOString().slice(0, 10)}`], "Could not commit worktree changes for parking.");
    else if (staged.code !== 0) throw new Error("Could not inspect staged worktree changes.");
    commit = await requireCommit(record.path, "HEAD");
    await advanceCleanupOperation(operation.id, "committed", commit);
    await requireGit(record.path, ["push", "origin", `HEAD:refs/heads/${record.branch}`], "Could not push the parked worktree branch.");
    await advanceCleanupOperation(operation.id, "pushed", commit);
    const remote = await requireGit(record.path, ["ls-remote", "--exit-code", "origin", `refs/heads/${record.branch}`], "Could not verify the parked branch on its remote.");
    if (remote.stdout.trim().split(/\s+/)[0] !== commit) throw new Error("The remote branch does not contain the exact parked commit; Pi Flash kept the local worktree.");
    await advanceCleanupOperation(operation.id, "remote-verified", commit);
    if (parsed.ignored > 0 && config.cleanup.ignoredFiles === "discard") await requireGit(record.path, ["clean", "-fdX"], "Could not discard explicitly allowed ignored files.");
    const [owner, name] = record.repo.split("/");
    if (!owner || !name) throw new Error("The registered repository identity is invalid.");
    const bare = getBareRepositoryPath(config.workspaceRoot, { owner, name });
    await requireGit(bare, ["worktree", "remove", record.path], "Could not remove the verified parked worktree.");
    await updateWorktreeRecord(record.id, (current) => ({ ...current, status: "removed" }));
    await advanceCleanupOperation(operation.id, "removed", commit);
    await appendHistory({ version: 1, at: new Date().toISOString(), event: "removed", metadata: { id: record.id, repo: record.repo, branch: record.branch, commit } });
    await advanceCleanupOperation(operation.id, "recorded", commit);
  } catch (error) {
    await appendHistory({ version: 1, at: new Date().toISOString(), event: "failure", metadata: { id: record.id, repo: record.repo, operation: operation.id, stage: "cleanup", commit } }).catch(() => undefined);
    throw error;
  }
}

async function inspectWorktree(record: WorktreeRecord, config: Config, now: number): Promise<CleanupProposal> {
  const reasons: string[] = [];
  const age = now - Date.parse(record.lastUsedAt);
  if (!Number.isFinite(age) || age < config.cleanup.inactiveAfterDays * 86_400_000) reasons.push("recently-used");
  if (record.activeLease !== null) reasons.push("active-session");
  try {
    const [root, path] = await Promise.all([realpath(config.workspaceRoot), realpath(record.path)]);
    const difference = relative(root, path);
    if (difference === "" || difference === ".." || difference.startsWith(`..${"/"}`) || difference.startsWith(`..${"\\"}`)) reasons.push("unsafe-path");
  } catch { reasons.push("missing-worktree"); }
  if (reasons.length > 0) return { record, eligible: false, reasons, trackedChanges: false, untracked: 0, ignored: 0 };
  const status = await git(record.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]);
  if (status.code !== 0) return { record, eligible: false, reasons: ["git-status-failed"], trackedChanges: false, untracked: 0, ignored: 0 };
  const parsed = parseStatus(status.stdout);
  if (parsed.conflicted) reasons.push("conflicts");
  if (await hasGitOperation(record.path)) reasons.push("git-operation-in-progress");
  if (parsed.untracked > 0 && config.cleanup.untrackedFiles === "block") reasons.push("untracked-files");
  if (parsed.ignored > 0 && (config.cleanup.untrackedFiles === "block" || config.cleanup.ignoredFiles === "block")) reasons.push("ignored-files");
  return { record, eligible: reasons.length === 0, reasons, trackedChanges: parsed.trackedChanges, untracked: parsed.untracked, ignored: parsed.ignored };
}

function parseStatus(output: string): { trackedChanges: boolean; untracked: number; ignored: number; conflicted: boolean } {
  let trackedChanges = false; let untracked = 0; let ignored = 0; let conflicted = false;
  for (const entry of output.split("\0")) {
    if (entry.length < 3) continue;
    const code = entry.slice(0, 2);
    if (code === "??") { untracked += 1; continue; }
    if (code === "!!") { ignored += 1; continue; }
    trackedChanges = true;
    if (code.includes("U") || code === "AA" || code === "DD") conflicted = true;
  }
  return { trackedChanges, untracked, ignored, conflicted };
}

async function hasGitOperation(cwd: string): Promise<boolean> {
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    const location = await git(cwd, ["rev-parse", "--git-path", name]);
    if (location.code !== 0) continue;
    try { await stat(location.stdout.trim()); return true; } catch { /* absent */ }
  }
  return false;
}

async function requireCommit(cwd: string, ref: string): Promise<string> { const result = await requireGit(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], "Could not resolve parked commit."); const sha = result.stdout.trim(); if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error("Git returned an invalid parked commit."); return sha; }
async function requireGit(cwd: string, args: string[], message: string) { const result = await git(cwd, args); if (result.code !== 0) throw new Error(`${message}${result.stderr.trim() ? ` ${result.stderr.trim()}` : ""}`); return result; }
async function git(cwd: string, args: string[]) { return runCommand("git", args, { cwd, timeoutMs: 60_000 }); }
