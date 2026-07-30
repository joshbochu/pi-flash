import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { getFlashStateDirectory, type ConfigLocationOptions } from "./config.js";
import type { WorkspacePreparation } from "./git-workspace.js";
import type { RepositoryIndexEntry } from "./index-store.js";
import { getProcessIdentity, isPidAlive, StateLockError, type StateLockOptions, withFileLock } from "./state-lock.js";

export const REGISTRY_VERSION = 1;

export type WorktreeStatus = "active" | "parked" | "removed";
export type CleanupOperationStatus = "planned" | "committed" | "pushed" | "remote-verified" | "removed" | "recorded" | "aborted";

export interface WorktreeRecord {
  id: string;
  repo: string;
  barePath: string;
  path: string;
  branch: string;
  base: { sha: string; stale: boolean; fetchedAt: string };
  createdAt: string;
  lastUsedAt: string;
  activeLease: { pid: number; heartbeatAt: string; processIdentity?: string } | null;
  status: WorktreeStatus;
}

export interface WorktreeRegistry {
  version: typeof REGISTRY_VERSION;
  worktrees: WorktreeRecord[];
  operations: CleanupOperation[];
}

export interface CleanupOperation {
  id: string;
  worktreeId: string;
  branch: string;
  status: CleanupOperationStatus;
  commit: string | null;
  startedAt: string;
  updatedAt: string;
}

export interface RegistryMutationOptions extends ConfigLocationOptions, StateLockOptions {
  now?: () => Date;
  id?: () => string;
}

export type CleanupClaimResult =
  | { claimed: true; record: WorktreeRecord; operation: CleanupOperation }
  | { claimed: false; reason: "not-found" | "not-active" | "active-session" };

export interface IncompleteCleanup {
  operation: CleanupOperation;
  record: WorktreeRecord;
}

export interface CleanupClaim {
  operation: CleanupOperation;
  record: WorktreeRecord;
}

export interface CompleteCleanupRemovalOptions extends RegistryMutationOptions {
  remove: (claim: CleanupClaim) => Promise<void>;
}

export class RegistryError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryError";
  }
}

export function getRegistryPath(options: ConfigLocationOptions = {}): string {
  return join(getFlashStateDirectory(options), "registry.json");
}

export function getRegistryLockPath(options: ConfigLocationOptions = {}): string {
  return join(getFlashStateDirectory(options), "registry.lock");
}

export async function readRegistry(options: ConfigLocationOptions = {}): Promise<WorktreeRegistry> {
  return readRegistryUnlocked(options);
}

async function readRegistryUnlocked(options: ConfigLocationOptions): Promise<WorktreeRegistry> {
  let content: string;
  try {
    content = await readFile(getRegistryPath(options), "utf8");
  } catch (error: unknown) {
    if (isNotFound(error)) return { version: REGISTRY_VERSION, worktrees: [], operations: [] };
    throw new RegistryError("Could not read the Pi Flash worktree registry.", { cause: asError(error) });
  }
  try {
    return parseRegistry(JSON.parse(content));
  } catch (error: unknown) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("The Pi Flash worktree registry is not valid JSON. Restore it from a backup before cleaning worktrees.", { cause: asError(error) });
  }
}

export function parseRegistry(value: unknown): WorktreeRegistry {
  const object = requireObject(value, "worktree registry");
  rejectUnknown(object, ["version", "worktrees", "operations"], "worktree registry");
  if (object.version !== REGISTRY_VERSION) throw new RegistryError("The worktree registry was created by an incompatible Pi Flash version.");
  if (!Array.isArray(object.worktrees)) throw new RegistryError("The worktree registry has an invalid worktrees list.");
  const ids = new Set<string>();
  const paths = new Set<string>();
  const worktrees = object.worktrees.map((record) => parseWorktreeRecord(record, ids, paths));
  if (object.operations !== undefined && !Array.isArray(object.operations)) throw new RegistryError("The worktree registry has an invalid operations list.");
  const operationIds = new Set<string>();
  const worktreeIds = new Set(worktrees.map((record) => record.id));
  const operations = (object.operations ?? []).map((operation) => parseCleanupOperation(operation, operationIds, worktreeIds));
  return { version: REGISTRY_VERSION, worktrees, operations };
}

async function writeRegistryUnlocked(registry: WorktreeRegistry, options: ConfigLocationOptions): Promise<void> {
  const parsed = parseRegistry(registry);
  const stateDirectory = getFlashStateDirectory(options);
  const destination = getRegistryPath(options);
  try {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(stateDirectory, 0o700);
    await atomicWrite(destination, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch (error: unknown) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("Could not write the Pi Flash worktree registry.", { cause: asError(error) });
  }
}

/** Adds a newly-created worktree before a Pi replacement is scheduled. */
export async function registerWorktree(
  repository: RepositoryIndexEntry,
  workspace: WorkspacePreparation,
  options: RegistryMutationOptions = {},
): Promise<WorktreeRecord> {
  const now = (options.now?.() ?? new Date()).toISOString();
  const record: WorktreeRecord = {
    id: options.id?.() ?? randomUUID(),
    repo: repository.nameWithOwner,
    barePath: workspace.barePath,
    path: workspace.worktreePath,
    branch: workspace.branch,
    base: { sha: workspace.baseSha, stale: workspace.stale, fetchedAt: workspace.lastFetchedAt },
    createdAt: now,
    lastUsedAt: now,
    activeLease: null,
    status: "active",
  };
  return transactRegistry(options, (registry) => {
    if (registry.worktrees.some((current) => current.path === workspace.worktreePath && current.status !== "removed")) {
      throw new RegistryError(`Pi Flash already tracks a worktree at ${workspace.worktreePath}.`);
    }
    registry.worktrees.push(record);
    return record;
  });
}

export async function setWorktreeLeaseForPath(path: string, pid: number, options: RegistryMutationOptions = {}): Promise<boolean> {
  const processIdentity = await getProcessIdentity(pid, options);
  return transactRegistry(options, (registry) => {
    const record = registry.worktrees.find((candidate) => candidate.path === path && candidate.status !== "removed");
    if (!record) return false;
    const heartbeatAt = (options.now?.() ?? new Date()).toISOString();
    record.activeLease = { pid, heartbeatAt, ...(processIdentity === null ? {} : { processIdentity }) };
    record.lastUsedAt = heartbeatAt;
    // Starting Pi in a claimed worktree cancels cleanup before it mutates Git.
    if (record.status === "parked") {
      record.status = "active";
      for (const operation of registry.operations) {
        if (
          operation.worktreeId === record.id
          && operation.status !== "aborted"
          && operation.status !== "recorded"
        ) {
          operation.status = "aborted";
          operation.updatedAt = heartbeatAt;
        }
      }
    }
    return true;
  }, (managed) => managed);
}

export async function clearWorktreeLeaseForPath(path: string, pid: number, options: RegistryMutationOptions = {}): Promise<void> {
  await transactRegistry(options, (registry) => {
    const record = registry.worktrees.find((candidate) => candidate.path === path && candidate.activeLease?.pid === pid);
    if (!record) return false;
    record.activeLease = null;
    return true;
  }, (cleared) => cleared);
}

export async function advanceCleanupOperation(
  id: string,
  status: CleanupOperationStatus,
  commit: string | null,
  options: RegistryMutationOptions = {},
): Promise<CleanupOperation> {
  return transactRegistry(options, (registry) => {
    const index = registry.operations.findIndex((operation) => operation.id === id);
    if (index < 0) throw new RegistryError(`Pi Flash does not track cleanup operation ${id}.`);
    const current = registry.operations[index]!;
    if (status !== "planned" && status !== "aborted" && commit === null) {
      throw new RegistryError("Verified cleanup stages require a commit.");
    }
    if (current.commit !== null && commit !== current.commit) {
      throw new RegistryError("A cleanup operation cannot change its parked commit.");
    }
    assertCleanupTransition(current.status, status);
    const updated = { ...current, status, commit, updatedAt: (options.now?.() ?? new Date()).toISOString() };
    registry.operations[index] = updated;
    return updated;
  });
}

/**
 * Atomically refreshes a cleanup candidate, rejects any live lease, changes
 * active -> parked, and records the durable planned operation. Filesystem and
 * Git checks happen after this claim; releaseCleanupClaim returns an unmutated
 * worktree to active when those checks fail.
 */
export async function claimWorktreeForCleanup(id: string, options: RegistryMutationOptions = {}): Promise<CleanupClaimResult> {
  return transactRegistry(options, async (registry) => {
    const record = registry.worktrees.find((candidate) => candidate.id === id);
    if (!record) return { claimed: false, reason: "not-found" };
    if (record.status !== "active") return { claimed: false, reason: "not-active" };
    if (record.activeLease !== null) {
      if (await isLeaseActive(record.activeLease, options)) return { claimed: false, reason: "active-session" };
      record.activeLease = null;
    }
    record.status = "parked";
    const operation = newCleanupOperation(record, options);
    registry.operations.push(operation);
    return { claimed: true, record: structuredClone(record), operation };
  }, (claim) => claim.claimed);
}

/**
 * Releases only the matching parked claim. Requiring the operation id prevents
 * an old cleanup attempt from releasing a newer claim.
 */
export async function releaseCleanupClaim(
  id: string,
  operationId: string,
  options: RegistryMutationOptions = {},
): Promise<WorktreeRecord | null> {
  return transactRegistry(options, (registry) => {
    const record = registry.worktrees.find((candidate) => candidate.id === id);
    const operation = registry.operations.find((candidate) => candidate.id === operationId && candidate.worktreeId === id);
    if (!record || !operation || record.status !== "parked" || operation.status !== "planned") return null;
    record.status = "active";
    operation.status = "aborted";
    operation.updatedAt = (options.now?.() ?? new Date()).toISOString();
    return structuredClone(record);
  }, (record) => record !== null);
}

/**
 * Performs the final locked claim check before a destructive cleanup step.
 * Callers should use the returned fresh paths rather than a prior scan record.
 */
export async function validateCleanupClaim(
  id: string,
  operationId: string,
  requiredOperationStatus?: CleanupOperationStatus,
  options: RegistryMutationOptions = {},
): Promise<CleanupClaim | null> {
  return withRegistryLock(options, async () => {
    const registry = await readRegistryUnlocked(options);
    const record = registry.worktrees.find((candidate) => candidate.id === id);
    const operation = registry.operations.find((candidate) => candidate.id === operationId && candidate.worktreeId === id);
    if (
      !record
      || !operation
      || record.status !== "parked"
      || record.activeLease !== null
      || operation.status === "aborted"
      || operation.status === "recorded"
      || (requiredOperationStatus !== undefined && operation.status !== requiredOperationStatus)
    ) return null;
    return { record: structuredClone(record), operation: structuredClone(operation) };
  });
}

/**
 * Holds the registry lock across the last claim check and worktree removal.
 * A Pi session therefore cannot acquire a lease in the gap between validation
 * and the destructive Git command.
 */
export async function completeCleanupRemoval(
  id: string,
  operationId: string,
  options: CompleteCleanupRemovalOptions,
): Promise<CleanupOperation> {
  return withRegistryLock(options, async () => {
    const registry = await readRegistryUnlocked(options);
    const record = registry.worktrees.find((candidate) => candidate.id === id);
    const operation = registry.operations.find((candidate) => candidate.id === operationId && candidate.worktreeId === id);
    if (
      !record
      || !operation
      || record.status !== "parked"
      || record.activeLease !== null
      || operation.status !== "remote-verified"
    ) {
      throw new RegistryError("The cleanup claim changed before worktree removal. Pi Flash kept the worktree.");
    }

    await options.remove({
      record: structuredClone(record),
      operation: structuredClone(operation),
    });

    const now = (options.now?.() ?? new Date()).toISOString();
    record.status = "removed";
    operation.status = "removed";
    operation.updatedAt = now;
    await writeRegistryUnlocked(registry, options);
    return structuredClone(operation);
  });
}

/** Clears only leases that are conclusively dead or belong to a recycled PID. */
export async function recoverStaleWorktreeLeases(options: RegistryMutationOptions = {}): Promise<number> {
  return transactRegistry(options, async (registry) => {
    let recovered = 0;
    for (const record of registry.worktrees) {
      if (record.activeLease !== null && !(await isLeaseActive(record.activeLease, options))) {
        record.activeLease = null;
        recovered += 1;
      }
    }
    return recovered;
  }, (recovered) => recovered > 0);
}

/** Returns durable, non-terminal cleanup work for a startup reconciler. */
export async function listIncompleteCleanupOperations(options: ConfigLocationOptions = {}): Promise<IncompleteCleanup[]> {
  const registry = await readRegistry(options);
  const worktrees = new Map(registry.worktrees.map((record) => [record.id, record]));
  return registry.operations.flatMap((operation) => {
    if (operation.status === "recorded" || operation.status === "aborted") return [];
    const record = worktrees.get(operation.worktreeId);
    return record ? [{ operation, record }] : [];
  });
}

async function transactRegistry<T>(
  options: RegistryMutationOptions,
  mutate: (registry: WorktreeRegistry) => T | Promise<T>,
  shouldWrite: (result: T) => boolean = () => true,
): Promise<T> {
  return withRegistryLock(options, async () => {
    const registry = await readRegistryUnlocked(options);
    const result = await mutate(registry);
    if (shouldWrite(result)) await writeRegistryUnlocked(registry, options);
    return result;
  });
}

async function withRegistryLock<T>(options: RegistryMutationOptions, action: () => Promise<T>): Promise<T> {
  try {
    return await withFileLock(getRegistryLockPath(options), action, options);
  } catch (error: unknown) {
    if (error instanceof StateLockError) {
      throw new RegistryError("Could not lock the Pi Flash worktree registry.", { cause: error });
    }
    throw error;
  }
}

function newCleanupOperation(record: WorktreeRecord, options: RegistryMutationOptions): CleanupOperation {
  const now = (options.now?.() ?? new Date()).toISOString();
  return {
    id: options.id?.() ?? randomUUID(),
    worktreeId: record.id,
    branch: record.branch,
    status: "planned",
    commit: null,
    startedAt: now,
    updatedAt: now,
  };
}

async function isLeaseActive(
  lease: NonNullable<WorktreeRecord["activeLease"]>,
  options: RegistryMutationOptions,
): Promise<boolean> {
  if (!isPidAlive(lease.pid, options)) return false;
  // Legacy leases do not carry a PID identity. A live legacy PID is retained:
  // expiring it based on age alone could remove an active user's worktree.
  if (lease.processIdentity === undefined) return true;
  const currentIdentity = await getProcessIdentity(lease.pid, options);
  // Failure to ask the OS is not proof of death.
  if (currentIdentity === null) return true;
  return currentIdentity === lease.processIdentity;
}

async function atomicWrite(destination: string, content: string): Promise<void> {
  const temporary = join(dirname(destination), `.registry.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

function parseWorktreeRecord(value: unknown, ids: Set<string>, paths: Set<string>): WorktreeRecord {
  const object = requireObject(value, "worktree record");
  rejectUnknown(object, ["id", "repo", "barePath", "path", "branch", "base", "createdAt", "lastUsedAt", "activeLease", "status"], "worktree record");
  const id = requireUuid(object.id, "worktree record.id");
  if (ids.has(id)) throw new RegistryError("The worktree registry has duplicate ids.");
  ids.add(id);
  const repo = requireRepo(object.repo, "worktree record.repo");
  const path = requireAbsolutePath(object.path, "worktree record.path");
  const barePath = object.barePath === undefined
    ? deriveLegacyBarePath(path, repo)
    : requireAbsolutePath(object.barePath, "worktree record.barePath");
  if (paths.has(path)) throw new RegistryError("The worktree registry has duplicate paths.");
  paths.add(path);
  const branch = requireBranch(object.branch, "worktree record.branch");
  const baseObject = requireObject(object.base, "worktree record.base");
  rejectUnknown(baseObject, ["sha", "stale", "fetchedAt"], "worktree record.base");
  const base = {
    sha: requireSha(baseObject.sha),
    stale: requireBoolean(baseObject.stale, "worktree record.base.stale"),
    fetchedAt: requireNonEmptyString(baseObject.fetchedAt, "worktree record.base.fetchedAt"),
  };
  const activeLease = object.activeLease === null ? null : parseActiveLease(object.activeLease);
  if (object.status !== "active" && object.status !== "parked" && object.status !== "removed") throw new RegistryError("The worktree registry has an invalid status.");
  return {
    id,
    repo,
    barePath,
    path,
    branch,
    base,
    createdAt: requireTimestamp(object.createdAt, "worktree record.createdAt"),
    lastUsedAt: requireTimestamp(object.lastUsedAt, "worktree record.lastUsedAt"),
    activeLease,
    status: object.status,
  };
}

function parseActiveLease(value: unknown): NonNullable<WorktreeRecord["activeLease"]> {
  const object = requireObject(value, "worktree record.activeLease");
  rejectUnknown(object, ["pid", "heartbeatAt", "processIdentity"], "worktree record.activeLease");
  if (typeof object.pid !== "number" || !Number.isSafeInteger(object.pid) || object.pid < 1) throw new RegistryError("worktree record.activeLease.pid is invalid.");
  const processIdentity = object.processIdentity === undefined
    ? undefined
    : requireNonEmptyString(object.processIdentity, "worktree record.activeLease.processIdentity");
  return {
    pid: object.pid,
    heartbeatAt: requireTimestamp(object.heartbeatAt, "worktree record.activeLease.heartbeatAt"),
    ...(processIdentity === undefined ? {} : { processIdentity }),
  };
}

function parseCleanupOperation(value: unknown, ids: Set<string>, worktreeIds: Set<string>): CleanupOperation {
  const object = requireObject(value, "cleanup operation");
  rejectUnknown(object, ["id", "worktreeId", "branch", "status", "commit", "startedAt", "updatedAt"], "cleanup operation");
  const id = requireUuid(object.id, "cleanup operation.id");
  if (ids.has(id)) throw new RegistryError("The worktree registry has duplicate cleanup operation ids.");
  ids.add(id);
  const worktreeId = requireUuid(object.worktreeId, "cleanup operation.worktreeId");
  if (!worktreeIds.has(worktreeId)) throw new RegistryError("A cleanup operation references an unknown worktree.");
  const branch = requireBranch(object.branch, "cleanup operation.branch");
  if (!isCleanupStatus(object.status)) throw new RegistryError("Cleanup operation status is invalid.");
  const commit = object.commit === null ? null : requireSha(object.commit);
  if (
    object.status !== "planned"
    && object.status !== "aborted"
    && commit === null
  ) {
    throw new RegistryError("A verified cleanup operation is missing its parked commit.");
  }
  return { id, worktreeId, branch, status: object.status, commit, startedAt: requireTimestamp(object.startedAt, "cleanup operation.startedAt"), updatedAt: requireTimestamp(object.updatedAt, "cleanup operation.updatedAt") };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RegistryError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function rejectUnknown(object: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new RegistryError(`${label} contains an unsupported property.`);
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new RegistryError(`${label} must be a UUID.`);
  }
  return value;
}

function requireRepo(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(value)) throw new RegistryError(`${label} is invalid.`);
  const [, name] = value.split("/");
  if (name === "." || name === "..") throw new RegistryError(`${label} is invalid.`);
  return value;
}

function deriveLegacyBarePath(path: string, repo: string): string {
  const [owner, name] = repo.split("/");
  const repositoryDirectory = dirname(path);
  const ownerDirectory = dirname(repositoryDirectory);
  const worktreesDirectory = dirname(ownerDirectory);
  if (
    !owner
    || !name
    || basename(repositoryDirectory) !== name
    || basename(ownerDirectory) !== owner
    || basename(worktreesDirectory) !== "worktrees"
  ) {
    throw new RegistryError(
      "A legacy worktree record has no barePath and does not use the supported workspace layout. Re-run /flash setup after backing up the registry.",
    );
  }
  return join(dirname(worktreesDirectory), ".flash", "repos", owner, `${name}.git`);
}

function requireAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) throw new RegistryError(`${label} must be an absolute path.`);
  return value;
}

function requireBranch(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes("..") || value.includes("//") || value.endsWith(".") || value.endsWith("/")) {
    throw new RegistryError(`${label} is invalid.`);
  }
  return value;
}

function requireSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/i.test(value)) throw new RegistryError("worktree record.base.sha is invalid.");
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new RegistryError(`${label} must be a boolean.`);
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new RegistryError(`${label} must be an ISO timestamp.`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new RegistryError(`${label} must be a non-empty string.`);
  return value;
}

function isCleanupStatus(value: unknown): value is CleanupOperationStatus {
  return value === "planned" || value === "committed" || value === "pushed" || value === "remote-verified" || value === "removed" || value === "recorded" || value === "aborted";
}

function cleanupStatusIndex(status: CleanupOperationStatus): number {
  return ["planned", "committed", "pushed", "remote-verified", "removed", "recorded"].indexOf(status);
}

function assertCleanupTransition(current: CleanupOperationStatus, next: CleanupOperationStatus): void {
  if (current === next) return;
  if (current === "aborted" || current === "recorded") {
    throw new RegistryError("Terminal cleanup operations cannot be advanced.");
  }
  if (next === "aborted") {
    return;
  }
  if (cleanupStatusIndex(next) !== cleanupStatusIndex(current) + 1) {
    throw new RegistryError("Cleanup operations must advance one verified stage at a time.");
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}
