import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import type { Config } from "./config.js";
import { appendHistory } from "./history.js";
import { runCommand } from "./process.js";
import {
  advanceCleanupOperation,
  claimWorktreeForCleanup,
  completeCleanupRemoval,
  listIncompleteCleanupOperations,
  readRegistry,
  recoverStaleWorktreeLeases,
  releaseCleanupClaim,
  validateCleanupClaim,
  type CleanupOperation,
  type WorktreeRecord,
} from "./registry.js";

export interface CleanupProposal { record: WorktreeRecord; eligible: boolean; reasons: string[]; trackedChanges: boolean; untracked: number; ignored: number; }
export interface CleanupReconciliation { reconciled: number; failures: string[]; recoveredLeases: number; }

/** Scans only Pi Flash registry entries; it never walks an arbitrary workspace. */
export async function scanCleanup(config: Config, now = Date.now()): Promise<CleanupProposal[]> {
  await recoverStaleWorktreeLeases();
  const registry = await readRegistry();
  const proposals: CleanupProposal[] = [];
  for (const record of registry.worktrees) {
    if (record.status === "active") proposals.push(await inspectWorktree(record, config, now));
  }
  return proposals;
}

export async function cleanEligibleWorktree(record: WorktreeRecord, config: Config): Promise<void> {
  const proposal = await inspectWorktree(record, config, Date.now());
  if (!proposal.eligible) {
    await recordCleanupSkipped(record, proposal.reasons);
    throw unsafeCleanupError(proposal.reasons);
  }

  const claim = await claimWorktreeForCleanup(record.id);
  if (!claim.claimed) {
    const reason = claim.reason === "active-session" ? "active-session" : "cleanup-state-changed";
    await recordCleanupSkipped(record, [reason]);
    throw unsafeCleanupError([reason]);
  }

  try {
    // The scan record can be arbitrarily old. Re-run every safety check using
    // the atomically claimed record before the first Git mutation.
    const claimedProposal = await inspectWorktree(claim.record, config, Date.now());
    if (!claimedProposal.eligible) {
      await releaseCleanupClaim(claim.record.id, claim.operation.id);
      await recordCleanupSkipped(claim.record, claimedProposal.reasons);
      throw unsafeCleanupError(claimedProposal.reasons);
    }
    await resumeCleanupOperation(claim.record, claim.operation, config);
  } catch (error) {
    // Only a planned claim can be rolled back. Once a commit may have been
    // pushed, retain the parked state so the reconciler can resume exactly.
    await releaseCleanupClaim(claim.record.id, claim.operation.id).catch(() => undefined);
    await appendHistory({
      version: 1,
      at: new Date().toISOString(),
      event: "failure",
      metadata: {
        id: claim.record.id,
        repo: claim.record.repo,
        operation: claim.operation.id,
        stage: "cleanup",
      },
    }).catch(() => undefined);
    throw error;
  }
}

/** Resumes durable cleanup operations left by a crash or detached-worker exit. */
export async function reconcileIncompleteCleanup(config: Config): Promise<CleanupReconciliation> {
  const recoveredLeases = await recoverStaleWorktreeLeases();
  const incomplete = await listIncompleteCleanupOperations();
  let reconciled = 0;
  const failures: string[] = [];

  for (const { record, operation } of incomplete) {
    try {
      if (record.status === "removed") {
        if (operation.status === "remote-verified") {
          await advanceCleanupOperation(operation.id, "removed", operation.commit);
          await recordRemoved(record, operation.commit);
          await advanceCleanupOperation(operation.id, "recorded", operation.commit);
        } else if (operation.status === "removed") {
          await recordRemoved(record, operation.commit);
          await advanceCleanupOperation(operation.id, "recorded", operation.commit);
        } else {
          throw new Error("The worktree is already absent before remote verification completed.");
        }
      } else {
        if (record.status !== "parked" || record.activeLease !== null) {
          throw new Error("The worktree is active; cleanup will not resume.");
        }
        await resumeCleanupOperation(record, operation, config);
      }
      reconciled += 1;
    } catch (error: unknown) {
      failures.push(`${record.repo}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { reconciled, failures, recoveredLeases };
}

async function resumeCleanupOperation(
  initialRecord: WorktreeRecord,
  initialOperation: CleanupOperation,
  config: Config,
): Promise<void> {
  let record = initialRecord;
  let operation = initialOperation;

  while (operation.status !== "recorded") {
    if (operation.status === "aborted") throw new Error("Cleanup was cancelled by an active Pi session.");

    if (operation.status === "planned") {
      ({ record } = await requireClaim(record.id, operation.id, "planned"));
      await validateManagedLayout(record);
      const status = await requireGit(record.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], "Could not inspect the claimed worktree.");
      const parsed = parseStatus(status.stdout);
      if (parsed.conflicted || await hasGitOperation(record.path)) {
        throw new Error("The claimed worktree has conflicts or a Git operation in progress.");
      }
      if (parsed.untracked > 0 && config.cleanup.untrackedFiles === "block") {
        throw unsafeCleanupError(["untracked-files"]);
      }
      if (parsed.ignored > 0 && config.cleanup.ignoredFiles === "block") {
        throw unsafeCleanupError(["ignored-files"]);
      }
      if (parsed.untracked > 0 && config.cleanup.untrackedFiles === "include-unignored") {
        await requireGit(record.path, ["add", "-A", "--", "."], "Could not stage non-ignored worktree changes.");
      } else {
        await requireGit(record.path, ["add", "-u"], "Could not stage tracked worktree changes.");
      }
      const staged = await git(record.path, ["diff", "--cached", "--quiet"]);
      if (staged.code === 1) {
        await requireGit(record.path, ["commit", "-m", `pi-flash: park ${new Date().toISOString().slice(0, 10)}`], "Could not commit worktree changes for parking.");
      } else if (staged.code !== 0) {
        throw new Error("Could not inspect staged worktree changes.");
      }
      const commit = await requireCommit(record.path, "HEAD");
      operation = await advanceCleanupOperation(operation.id, "committed", commit);
      continue;
    }

    if (operation.status === "committed") {
      ({ record, operation } = await requireClaim(record.id, operation.id, "committed"));
      const commit = requireOperationCommit(operation);
      await validateManagedRepositoryLayout(record);
      await requireGit(record.barePath, ["push", "origin", `${commit}:refs/heads/${operation.branch}`], "Could not push the parked worktree branch.");
      operation = await advanceCleanupOperation(operation.id, "pushed", commit);
      continue;
    }

    if (operation.status === "pushed") {
      ({ record, operation } = await requireClaim(record.id, operation.id, "pushed"));
      const commit = requireOperationCommit(operation);
      await validateManagedRepositoryLayout(record);
      const remote = await requireGit(record.barePath, ["ls-remote", "--exit-code", "origin", `refs/heads/${operation.branch}`], "Could not verify the parked branch on its remote.");
      if (remote.stdout.trim().split(/\s+/)[0] !== commit) {
        throw new Error("The remote branch does not contain the exact parked commit; Pi Flash kept the local worktree.");
      }
      operation = await advanceCleanupOperation(operation.id, "remote-verified", commit);
      continue;
    }

    if (operation.status === "remote-verified") {
      ({ record, operation } = await requireClaim(record.id, operation.id, "remote-verified"));
      const commit = requireOperationCommit(operation);
      const worktreeMissing = await isAbsent(record.path);
      if (worktreeMissing) await validateManagedRepositoryLayout(record);
      else await validateManagedLayout(record);
      await appendHistory({
        version: 1,
        at: new Date().toISOString(),
        event: "parked",
        metadata: { id: record.id, repo: record.repo, branch: operation.branch, commit },
      });
      if (!worktreeMissing) await ensureNoUnpublishedFiles(record, config);
      operation = await completeCleanupRemoval(record.id, operation.id, {
        remove: async (fresh) => {
          if (await isAbsent(fresh.record.path)) {
            await validateManagedRepositoryLayout(fresh.record);
            await requireGit(fresh.record.barePath, ["worktree", "prune"], "Could not reconcile the removed worktree.");
          } else {
            await validateManagedLayout(fresh.record);
            await requireGit(
              fresh.record.barePath,
              ["worktree", "remove", fresh.record.path],
              "Could not remove the verified parked worktree.",
            );
          }
        },
      });
      continue;
    }

    if (operation.status === "removed") {
      await recordRemoved(record, operation.commit);
      operation = await advanceCleanupOperation(operation.id, "recorded", operation.commit);
      continue;
    }

    throw new Error(`Unsupported cleanup operation state: ${operation.status}.`);
  }
}

async function inspectWorktree(record: WorktreeRecord, config: Config, now: number): Promise<CleanupProposal> {
  const reasons: string[] = [];
  const age = now - Date.parse(record.lastUsedAt);
  if (!Number.isFinite(age) || age < config.cleanup.inactiveAfterDays * 86_400_000) reasons.push("recently-used");
  if (record.activeLease !== null) reasons.push("active-session");
  try {
    await validateManagedLayout(record);
  } catch { reasons.push("unsafe-or-missing-worktree"); }
  if (reasons.length > 0) return { record, eligible: false, reasons, trackedChanges: false, untracked: 0, ignored: 0 };
  const status = await git(record.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]);
  if (status.code !== 0) return { record, eligible: false, reasons: ["git-status-failed"], trackedChanges: false, untracked: 0, ignored: 0 };
  const parsed = parseStatus(status.stdout);
  if (parsed.conflicted) reasons.push("conflicts");
  if (await hasGitOperation(record.path)) reasons.push("git-operation-in-progress");
  if (parsed.untracked > 0 && config.cleanup.untrackedFiles === "block") reasons.push("untracked-files");
  if (parsed.ignored > 0 && config.cleanup.ignoredFiles === "block") reasons.push("ignored-files");
  return { record, eligible: reasons.length === 0, reasons, trackedChanges: parsed.trackedChanges, untracked: parsed.untracked, ignored: parsed.ignored };
}

async function requireClaim(
  id: string,
  operationId: string,
  status: CleanupOperation["status"],
): Promise<{ record: WorktreeRecord; operation: CleanupOperation }> {
  const claim = await validateCleanupClaim(id, operationId, status);
  if (!claim) throw new Error("The cleanup claim changed. Pi Flash kept the worktree.");
  return claim;
}

/**
 * Validates the persisted owner/repository layout independently of the current
 * configured root. This permits safe cleanup after a user changes roots while
 * rejecting symlinks which escape the root or unexpected registry paths.
 */
async function validateManagedLayout(record: WorktreeRecord): Promise<void> {
  const { canonicalParent } = await validateManagedRepositoryLayout(record);
  const canonicalWorktree = await realpath(record.path);
  if (dirname(canonicalWorktree) !== canonicalParent || basename(canonicalWorktree) === "") {
    throw new Error("The registered worktree is outside the managed Pi Flash layout.");
  }
}

async function validateManagedRepositoryLayout(record: WorktreeRecord): Promise<{ canonicalParent: string }> {
  const [owner, name, extra] = record.repo.split("/");
  if (!owner || !name || extra !== undefined) throw new Error("The registered repository identity is invalid.");

  const bareOwnerDirectory = dirname(record.barePath);
  const repositoriesDirectory = dirname(bareOwnerDirectory);
  const flashDirectory = dirname(repositoriesDirectory);
  const workspaceRoot = dirname(flashDirectory);
  if (
    basename(record.barePath) !== `${name}.git`
    || basename(bareOwnerDirectory) !== owner
    || basename(repositoriesDirectory) !== "repos"
    || basename(flashDirectory) !== ".flash"
    || dirname(record.path) !== join(workspaceRoot, "worktrees", owner, name)
    || basename(record.path) === ""
  ) {
    throw new Error("The registered repository is outside the managed Pi Flash layout.");
  }

  const expectedParent = join(workspaceRoot, "worktrees", owner, name);
  const [canonicalRoot, canonicalBare, canonicalParent] = await Promise.all([
    realpath(workspaceRoot),
    realpath(record.barePath),
    realpath(expectedParent),
  ]);
  if (
    escapes(canonicalRoot, canonicalBare)
    || escapes(canonicalRoot, canonicalParent)
  ) {
    throw new Error("The registered repository is outside the managed Pi Flash layout.");
  }
  return { canonicalParent };
}

async function ensureNoUnpublishedFiles(record: WorktreeRecord, config: Config): Promise<void> {
  const status = await requireGit(
    record.path,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"],
    "Could not perform the final worktree safety check.",
  );
  const parsed = parseStatus(status.stdout);
  if (parsed.trackedChanges || parsed.untracked > 0 || parsed.conflicted || await hasGitOperation(record.path)) {
    throw new Error("The worktree changed after parking. Pi Flash kept it for another cleanup pass.");
  }
  if (parsed.ignored > 0) {
    if (config.cleanup.ignoredFiles !== "discard") throw unsafeCleanupError(["ignored-files"]);
    await requireGit(record.path, ["clean", "-fdX"], "Could not discard explicitly allowed ignored files.");
  }
  const finalStatus = await requireGit(
    record.path,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"],
    "Could not verify the worktree after cleaning ignored files.",
  );
  if (finalStatus.stdout !== "") {
    throw new Error("Files remain in the worktree after the final safety check. Pi Flash kept it.");
  }
}

function requireOperationCommit(operation: CleanupOperation): string {
  if (operation.commit === null) throw new Error("The cleanup operation has no verified commit.");
  return operation.commit;
}

async function recordCleanupSkipped(record: WorktreeRecord, reasons: string[]): Promise<void> {
  await appendHistory({
    version: 1,
    at: new Date().toISOString(),
    event: "cleanup-skipped",
    metadata: { id: record.id, repo: record.repo, reason: reasons.join(",") },
  });
}

async function recordRemoved(record: WorktreeRecord, commit: string | null): Promise<void> {
  await appendHistory({
    version: 1,
    at: new Date().toISOString(),
    event: "removed",
    metadata: { id: record.id, repo: record.repo, branch: record.branch, commit },
  });
}

function unsafeCleanupError(reasons: string[]): Error {
  return new Error(`This worktree is not safe to clean: ${reasons.join(", ")}.`);
}

function escapes(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === "" || difference === ".." || difference.startsWith("../") || difference.startsWith("..\\");
}

async function isAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
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
async function requireGit(cwd: string, args: string[], message: string) { const result = await git(cwd, args); if (result.code !== 0) throw new Error(result.timedOut ? `${message} The command timed out.` : message); return result; }
async function git(cwd: string, args: string[]) { return runCommand("git", args, { cwd, timeoutMs: 60_000 }); }
