import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { Config } from "./config.js";
import type { RepositoryIndexEntry } from "./index-store.js";
import { runCommand, type CommandResult } from "./process.js";
import { StateLockError, withFileLock } from "./state-lock.js";

export interface WorkspacePreparation {
  barePath: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
  stale: boolean;
  attempts: number;
  lastFetchedAt: string;
}

export interface WorkspacePreparationOptions {
  /** Test-only override. Production derives the canonical github.com URL. */
  remoteUrl?: string;
  /** Replaces pet-name generation in deterministic tests. */
  createPetName?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

export class GitWorkspaceError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitWorkspaceError";
  }
}

/**
 * Prepares a distinct worktree for one launch. It never shares a branch or
 * working directory with another launch; only the compact bare object store is
 * shared by the canonical owner/repository identity.
 */
export async function prepareWorkspace(
  repository: RepositoryIndexEntry,
  config: Config,
  branchNamespace: string,
  options: WorkspacePreparationOptions = {},
): Promise<WorkspacePreparation> {
  assertSafeSegment(repository.owner, "repository owner");
  assertSafeSegment(repository.name, "repository name");
  assertSafeBranchComponent(branchNamespace, "branch namespace");
  assertSafeBranchComponent(repository.defaultBranch, "default branch");

  const repositoryLock = join(
    config.workspaceRoot,
    ".flash",
    "locks",
    `${createHash("sha256").update(repository.nameWithOwner.toLowerCase()).digest("hex")}.lock`,
  );
  try {
    return await withFileLock(
      repositoryLock,
      () => prepareWorkspaceLocked(repository, config, branchNamespace, options),
      { lockTimeoutMs: 300_000, lockRetryMs: 50 },
    );
  } catch (error: unknown) {
    if (error instanceof StateLockError) {
      throw new GitWorkspaceError("Could not lock the shared repository while preparing a worktree.", { cause: error });
    }
    throw error;
  }
}

async function prepareWorkspaceLocked(
  repository: RepositoryIndexEntry,
  config: Config,
  branchNamespace: string,
  options: WorkspacePreparationOptions,
): Promise<WorkspacePreparation> {
  const remoteUrl = options.remoteUrl ?? `https://github.com/${repository.nameWithOwner}.git`;
  const barePath = join(config.workspaceRoot, ".flash", "repos", repository.owner, `${repository.name}.git`);
  const worktreeParent = join(config.workspaceRoot, "worktrees", repository.owner, repository.name);
  const bareExists = await directoryExists(barePath);
  let base: { sha: string; stale: boolean; attempts: number; lastFetchedAt: string };

  if (bareExists) {
    await verifyOrigin(barePath, remoteUrl);
    base = await fetchDefaultBranch(barePath, repository.defaultBranch, config, options);
  } else {
    await mkdir(join(config.workspaceRoot, ".flash", "repos", repository.owner), { recursive: true, mode: 0o700 });
    await cloneBareRepository(barePath, remoteUrl);
    base = await captureClonedDefaultBranch(barePath, repository.defaultBranch, options.now);
  }

  await mkdir(worktreeParent, { recursive: true, mode: 0o700 });
  const createPetName = options.createPetName ?? createPetNameDefault;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const petName = createPetName();
    assertSafeSegment(petName, "generated worktree name");
    const branch = `${branchNamespace}/${petName}`;
    const worktreePath = join(worktreeParent, petName);
    if (await pathExists(worktreePath) || await branchExists(barePath, branch)) continue;

    const added = await git(barePath, ["worktree", "add", "-b", branch, worktreePath, base.sha]);
    if (added.code === 0) {
      return {
        barePath,
        worktreePath,
        branch,
        baseSha: base.sha,
        stale: base.stale,
        attempts: base.attempts,
        lastFetchedAt: base.lastFetchedAt,
      };
    }
    // A concurrent invocation may have won this pet-name/branch race. Try a
    // fresh name only for an already-exists response; surface all other Git
    // failures rather than guessing which state is safe to delete.
    if (await pathExists(worktreePath) || await branchExists(barePath, branch)) continue;
    throw commandFailure("Could not create the isolated Git worktree.", added);
  }
  throw new GitWorkspaceError("Could not allocate a unique Pi Flash worktree name after 32 attempts.");
}

export function getBareRepositoryPath(workspaceRoot: string, repository: Pick<RepositoryIndexEntry, "owner" | "name">): string {
  return join(workspaceRoot, ".flash", "repos", repository.owner, `${repository.name}.git`);
}

export function getWorktreeParentPath(workspaceRoot: string, repository: Pick<RepositoryIndexEntry, "owner" | "name">): string {
  return join(workspaceRoot, "worktrees", repository.owner, repository.name);
}

async function cloneBareRepository(barePath: string, remoteUrl: string): Promise<void> {
  const cloned = await runCommand("git", ["clone", "--bare", "--filter=blob:none", remoteUrl, barePath], { timeoutMs: 120_000 });
  if (cloned.code !== 0) throw commandFailure("Could not clone the repository for Pi Flash.", cloned);
}

async function captureClonedDefaultBranch(
  barePath: string,
  defaultBranch: string,
  now: (() => Date) | undefined,
): Promise<{ sha: string; stale: boolean; attempts: number; lastFetchedAt: string }> {
  const headRef = `refs/heads/${defaultBranch}`;
  const sha = await resolveCommit(barePath, headRef);
  if (!sha) {
    throw new GitWorkspaceError(`The fresh clone did not contain default branch ${defaultBranch}. Pi Flash did not create a worktree.`);
  }
  const cacheRef = cachedDefaultBranchRef(defaultBranch);
  const stored = await git(barePath, ["update-ref", cacheRef, sha]);
  if (stored.code !== 0) throw commandFailure("Could not record the cloned default branch.", stored);
  return { sha, stale: false, attempts: 0, lastFetchedAt: (now?.() ?? new Date()).toISOString() };
}

async function verifyOrigin(barePath: string, expectedRemoteUrl: string): Promise<void> {
  const remote = await git(barePath, ["remote", "get-url", "origin"]);
  if (remote.code !== 0) throw commandFailure("The existing Pi Flash bare repository has no usable origin remote.", remote);
  if (remote.stdout.trim() !== expectedRemoteUrl) {
    throw new GitWorkspaceError(
      `Refusing to reuse ${barePath}: its origin does not match the selected repository. Pi Flash left both repositories untouched.`,
    );
  }
}

async function fetchDefaultBranch(
  barePath: string,
  defaultBranch: string,
  config: Config,
  options: WorkspacePreparationOptions,
): Promise<{ sha: string; stale: boolean; attempts: number; lastFetchedAt: string }> {
  const cacheRef = cachedDefaultBranchRef(defaultBranch);
  let lastFailure: CommandResult | undefined;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= config.fetch.attempts; attempt += 1) {
    const result = await git(barePath, ["fetch", "--no-tags", "origin", `+refs/heads/${defaultBranch}:${cacheRef}`], config.fetch.timeoutSeconds * 1_000);
    if (result.code === 0) {
      const sha = await resolveCommit(barePath, cacheRef);
      if (!sha) throw new GitWorkspaceError(`Git fetched ${defaultBranch} but did not provide a usable commit.`);
      return { sha, stale: false, attempts: attempt, lastFetchedAt: (options.now?.() ?? new Date()).toISOString() };
    }
    lastFailure = result;
    if (attempt < config.fetch.attempts) {
      await sleep(config.fetch.initialBackoffMilliseconds * 2 ** (attempt - 1));
    }
  }

  const sha = await resolveCommit(barePath, cacheRef);
  if (!sha) {
    throw commandFailure(
      `Git could not fetch ${defaultBranch} after ${config.fetch.attempts} attempts and no verified cached commit is available.`,
      lastFailure,
    );
  }
  const timestamp = await commitTimestamp(barePath, sha);
  return { sha, stale: true, attempts: config.fetch.attempts, lastFetchedAt: timestamp };
}

function cachedDefaultBranchRef(branch: string): string {
  return `refs/pi-flash/default/${branch}`;
}

async function resolveCommit(barePath: string, reference: string): Promise<string | undefined> {
  const result = await git(barePath, ["rev-parse", "--verify", `${reference}^{commit}`]);
  if (result.code !== 0) return undefined;
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new GitWorkspaceError("Git returned an invalid commit identifier.");
  return sha;
}

async function commitTimestamp(barePath: string, sha: string): Promise<string> {
  const result = await git(barePath, ["show", "-s", "--format=%cI", sha]);
  if (result.code !== 0 || Number.isNaN(Date.parse(result.stdout.trim()))) return "an unknown time";
  return result.stdout.trim();
}

async function branchExists(barePath: string, branch: string): Promise<boolean> {
  const result = await git(barePath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  return result.code === 0;
}

async function git(cwd: string, args: string[], timeoutMs = 30_000) {
  return runCommand("git", args, { cwd, timeoutMs });
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error: unknown) {
    if (isNotFound(error)) return false;
    throw new GitWorkspaceError(`Could not inspect ${path}.`, { cause: error instanceof Error ? error : undefined });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (isNotFound(error)) return false;
    throw new GitWorkspaceError(`Could not inspect ${path}.`, { cause: error instanceof Error ? error : undefined });
  }
}

function assertSafeSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new GitWorkspaceError(`Unsafe ${label}.`);
  }
}

function assertSafeBranchComponent(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/") || value.endsWith(".")) {
    throw new GitWorkspaceError(`Unsafe ${label}.`);
  }
}

function createPetNameDefault(): string {
  const adjectives = ["brisk", "calm", "clever", "cobalt", "daring", "gentle", "lucky", "nimble", "quiet", "swift"];
  const animals = ["badger", "falcon", "gecko", "otter", "panda", "raven", "tiger", "wren", "yak", "zebra"];
  const adjective = adjectives[randomBytes(1)[0]! % adjectives.length]!;
  const animal = animals[randomBytes(1)[0]! % animals.length]!;
  const suffix = randomBytes(3).toString("hex");
  return `${adjective}-${animal}-${suffix}`;
}

function commandFailure(message: string, result: { code: number; stderr: string; timedOut: boolean } | undefined): GitWorkspaceError {
  const timeout = result?.timedOut ? " The command timed out." : "";
  return new GitWorkspaceError(`${message}${timeout}`);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
