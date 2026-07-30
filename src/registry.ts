import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getFlashStateDirectory, type ConfigLocationOptions } from "./config.js";
import type { WorkspacePreparation } from "./git-workspace.js";
import type { RepositoryIndexEntry } from "./index-store.js";

export const REGISTRY_VERSION = 1;

export type WorktreeStatus = "active" | "parked" | "removed";
export type CleanupOperationStatus = "planned" | "committed" | "pushed" | "remote-verified" | "removed" | "recorded";

export interface WorktreeRecord {
  id: string;
  repo: string;
  path: string;
  branch: string;
  base: { sha: string; stale: boolean; fetchedAt: string };
  createdAt: string;
  lastUsedAt: string;
  activeLease: { pid: number; heartbeatAt: string } | null;
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

export class RegistryError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryError";
  }
}

export function getRegistryPath(options: ConfigLocationOptions = {}): string {
  return join(getFlashStateDirectory(options), "registry.json");
}

export async function readRegistry(options: ConfigLocationOptions = {}): Promise<WorktreeRegistry> {
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

export async function writeRegistry(registry: WorktreeRegistry, options: ConfigLocationOptions = {}): Promise<void> {
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
  options: ConfigLocationOptions & { now?: () => Date; id?: () => string } = {},
): Promise<WorktreeRecord> {
  const registry = await readRegistry(options);
  if (registry.worktrees.some((record) => record.path === workspace.worktreePath && record.status !== "removed")) {
    throw new RegistryError(`Pi Flash already tracks a worktree at ${workspace.worktreePath}.`);
  }
  const now = (options.now?.() ?? new Date()).toISOString();
  const record: WorktreeRecord = {
    id: options.id?.() ?? randomUUID(),
    repo: repository.nameWithOwner,
    path: workspace.worktreePath,
    branch: workspace.branch,
    base: { sha: workspace.baseSha, stale: workspace.stale, fetchedAt: workspace.lastFetchedAt },
    createdAt: now,
    lastUsedAt: now,
    activeLease: null,
    status: "active",
  };
  registry.worktrees.push(record);
  await writeRegistry(registry, options);
  return record;
}

export async function updateWorktreeRecord(
  id: string,
  mutate: (record: WorktreeRecord) => WorktreeRecord,
  options: ConfigLocationOptions = {},
): Promise<WorktreeRecord> {
  const registry = await readRegistry(options);
  const index = registry.worktrees.findIndex((record) => record.id === id);
  if (index < 0) throw new RegistryError(`Pi Flash does not track worktree ${id}.`);
  const current = registry.worktrees[index]!;
  const updated = mutate(current);
  registry.worktrees[index] = parseWorktreeRecord(updated, new Set(registry.worktrees.filter((record) => record.id !== id).map((record) => record.id)), new Set(registry.worktrees.filter((record) => record.id !== id).map((record) => record.path)));
  await writeRegistry(registry, options);
  return registry.worktrees[index]!;
}

export async function setWorktreeLeaseForPath(path: string, pid: number, options: ConfigLocationOptions & { now?: () => Date } = {}): Promise<void> {
  const registry = await readRegistry(options);
  const record = registry.worktrees.find((candidate) => candidate.path === path && candidate.status === "active");
  if (!record) return;
  record.activeLease = { pid, heartbeatAt: (options.now?.() ?? new Date()).toISOString() };
  record.lastUsedAt = record.activeLease.heartbeatAt;
  await writeRegistry(registry, options);
}

export async function clearWorktreeLeaseForPath(path: string, pid: number, options: ConfigLocationOptions = {}): Promise<void> {
  const registry = await readRegistry(options);
  const record = registry.worktrees.find((candidate) => candidate.path === path && candidate.activeLease?.pid === pid);
  if (!record) return;
  record.activeLease = null;
  await writeRegistry(registry, options);
}

export async function createCleanupOperation(
  record: WorktreeRecord,
  options: ConfigLocationOptions & { now?: () => Date; id?: () => string } = {},
): Promise<CleanupOperation> {
  const registry = await readRegistry(options);
  const now = (options.now?.() ?? new Date()).toISOString();
  const operation: CleanupOperation = { id: options.id?.() ?? randomUUID(), worktreeId: record.id, branch: record.branch, status: "planned", commit: null, startedAt: now, updatedAt: now };
  registry.operations.push(operation);
  await writeRegistry(registry, options);
  return operation;
}

export async function advanceCleanupOperation(
  id: string,
  status: CleanupOperationStatus,
  commit: string | null,
  options: ConfigLocationOptions & { now?: () => Date } = {},
): Promise<CleanupOperation> {
  const registry = await readRegistry(options);
  const index = registry.operations.findIndex((operation) => operation.id === id);
  if (index < 0) throw new RegistryError(`Pi Flash does not track cleanup operation ${id}.`);
  const current = registry.operations[index]!;
  if (cleanupStatusIndex(status) < cleanupStatusIndex(current.status)) throw new RegistryError("Cleanup operations cannot move backward.");
  const updated = { ...current, status, commit, updatedAt: (options.now?.() ?? new Date()).toISOString() };
  registry.operations[index] = updated;
  await writeRegistry(registry, options);
  return updated;
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
  rejectUnknown(object, ["id", "repo", "path", "branch", "base", "createdAt", "lastUsedAt", "activeLease", "status"], "worktree record");
  const id = requireUuid(object.id, "worktree record.id");
  if (ids.has(id)) throw new RegistryError("The worktree registry has duplicate ids.");
  ids.add(id);
  const repo = requireRepo(object.repo, "worktree record.repo");
  const path = requireAbsolutePath(object.path, "worktree record.path");
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
    path,
    branch,
    base,
    createdAt: requireTimestamp(object.createdAt, "worktree record.createdAt"),
    lastUsedAt: requireTimestamp(object.lastUsedAt, "worktree record.lastUsedAt"),
    activeLease,
    status: object.status,
  };
}

function parseActiveLease(value: unknown): { pid: number; heartbeatAt: string } {
  const object = requireObject(value, "worktree record.activeLease");
  rejectUnknown(object, ["pid", "heartbeatAt"], "worktree record.activeLease");
  if (typeof object.pid !== "number" || !Number.isSafeInteger(object.pid) || object.pid < 1) throw new RegistryError("worktree record.activeLease.pid is invalid.");
  return { pid: object.pid, heartbeatAt: requireTimestamp(object.heartbeatAt, "worktree record.activeLease.heartbeatAt") };
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
  return value;
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
  return value === "planned" || value === "committed" || value === "pushed" || value === "remote-verified" || value === "removed" || value === "recorded";
}

function cleanupStatusIndex(status: CleanupOperationStatus): number {
  return ["planned", "committed", "pushed", "remote-verified", "removed", "recorded"].indexOf(status);
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}
