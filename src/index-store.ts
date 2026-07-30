import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getFlashStateDirectory, type ConfigLocationOptions } from "./config.js";
import { CommandError, runCommand } from "./process.js";

export const INDEX_VERSION = 1;

export interface RepositoryIndexEntry {
  nameWithOwner: string;
  name: string;
  owner: string;
  defaultBranch: string;
  description: string;
}

export interface RepositoryIndex {
  version: typeof INDEX_VERSION;
  refreshedAt: string;
  repos: RepositoryIndexEntry[];
}

export class IndexError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IndexError";
  }
}

export interface IndexLocationOptions extends ConfigLocationOptions {}

export type RepositoryLister = (owner: string) => Promise<unknown[]>;

export function getIndexPath(options: IndexLocationOptions = {}): string {
  return join(getFlashStateDirectory(options), "index.json");
}

/** Returns the last fully written index, or undefined before its first refresh. */
export async function readRepositoryIndex(options: IndexLocationOptions = {}): Promise<RepositoryIndex | undefined> {
  let content: string;
  try {
    content = await readFile(getIndexPath(options), "utf8");
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    throw new IndexError(`Could not read the Pi Flash repository index.`, { cause: error instanceof Error ? error : undefined });
  }

  try {
    return parseRepositoryIndex(JSON.parse(content));
  } catch (error: unknown) {
    if (error instanceof IndexError) throw error;
    throw new IndexError("The Pi Flash repository index is not valid JSON. Run /flash refresh to replace it.", {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

export function parseRepositoryIndex(value: unknown): RepositoryIndex {
  const object = requireObject(value, "repository index");
  rejectUnknown(object, ["version", "refreshedAt", "repos"], "repository index");
  if (object.version !== INDEX_VERSION) {
    throw new IndexError("The repository index was created by an incompatible Pi Flash version. Run /flash refresh.");
  }
  if (typeof object.refreshedAt !== "string" || Number.isNaN(Date.parse(object.refreshedAt))) {
    throw new IndexError("The repository index has an invalid refresh timestamp. Run /flash refresh.");
  }
  if (!Array.isArray(object.repos)) throw new IndexError("The repository index has an invalid repositories list. Run /flash refresh.");

  const seen = new Set<string>();
  const repos = object.repos.map((entry) => parseStoredRepositoryEntry(entry, seen));
  return { version: INDEX_VERSION, refreshedAt: object.refreshedAt, repos };
}

export function isIndexStale(index: RepositoryIndex, maxAgeHours: number, now = Date.now()): boolean {
  return Date.parse(index.refreshedAt) + maxAgeHours * 60 * 60 * 1000 <= now;
}

/**
 * Retrieves all enabled owner scopes through gh and swaps the on-disk index
 * only after every scope succeeds. A failed refresh therefore preserves the
 * prior complete cache.
 */
export async function refreshRepositoryIndex(
  enabledOwners: readonly string[],
  options: IndexLocationOptions & { now?: () => Date; listRepositories?: RepositoryLister } = {},
): Promise<RepositoryIndex> {
  const owners = [...new Set(enabledOwners)].sort((left, right) => left.localeCompare(right));
  const listRepositories = options.listRepositories ?? listOwnerRepositories;
  const allRepos = (await Promise.all(owners.map((owner) => listRepositories(owner)))).flat();
  const seen = new Set<string>();
  const repos = allRepos
    .filter((entry) => isActiveRepository(entry))
    .filter((entry) => hasDefaultBranch(entry))
    .map((entry) => parseRepositoryEntry(entry, seen))
    .sort((left, right) => left.nameWithOwner.localeCompare(right.nameWithOwner));
  const index: RepositoryIndex = {
    version: INDEX_VERSION,
    refreshedAt: (options.now?.() ?? new Date()).toISOString(),
    repos,
  };
  await writeRepositoryIndex(index, options);
  return index;
}

export async function writeRepositoryIndex(index: RepositoryIndex, options: IndexLocationOptions = {}): Promise<void> {
  const parsed = parseRepositoryIndex(index);
  const stateDirectory = getFlashStateDirectory(options);
  const destination = getIndexPath(options);
  try {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(stateDirectory, 0o700);
    await atomicWrite(destination, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch (error: unknown) {
    if (error instanceof IndexError) throw error;
    throw new IndexError("Could not write the Pi Flash repository index.", { cause: error instanceof Error ? error : undefined });
  }
}

export function enabledSourceOwners(sources: Record<string, boolean>): string[] {
  return Object.entries(sources)
    .filter(([, enabled]) => enabled)
    .map(([owner]) => owner)
    .sort((left, right) => left.localeCompare(right));
}

export async function listOwnerRepositories(owner: string): Promise<unknown[]> {
  const result = await runCommand("gh", [
    "repo",
    "list",
    owner,
    "--limit",
    "100000",
    "--json",
    "nameWithOwner,name,owner,defaultBranchRef,description,isArchived",
  ], { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 * 1024 });
  if (result.code !== 0) {
    throw new CommandError(`Could not list repositories for ${owner}.`, result);
  }
  if (result.stdoutTruncated) {
    throw new IndexError(`GitHub returned too much repository data for ${owner}; the index was left unchanged.`);
  }
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(value)) throw new Error("expected a JSON array");
    return value.filter((entry) => isActiveRepository(entry));
  } catch (error: unknown) {
    throw new IndexError(`GitHub returned an invalid repository list for ${owner}.`, { cause: error instanceof Error ? error : undefined });
  }
}

function isActiveRepository(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>).isArchived !== true;
}

/**
 * GitHub reports an empty repository with a null defaultBranchRef. Empty
 * repositories cannot produce a worktree yet, so leave them out of the cache
 * without allowing one of them to abort an otherwise healthy owner refresh.
 */
function hasDefaultBranch(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  const defaultBranchRef = (value as Record<string, unknown>).defaultBranchRef;
  return defaultBranchRef !== null;
}

function parseRepositoryEntry(value: unknown, seen: Set<string>): RepositoryIndexEntry {
  const object = requireObject(value, "repository entry");
  rejectUnknown(object, ["nameWithOwner", "name", "owner", "defaultBranchRef", "description", "isArchived"], "repository entry");
  const nameWithOwner = requireRepositoryName(object.nameWithOwner, "repository entry.nameWithOwner");
  const separator = nameWithOwner.indexOf("/");
  const owner = parseOwner(object.owner);
  const name = requireRepositoryPart(object.name, "repository entry.name");
  if (nameWithOwner.slice(0, separator) !== owner || nameWithOwner.slice(separator + 1) !== name) {
    throw new IndexError("GitHub returned an inconsistent repository name.");
  }
  if (object.defaultBranchRef === null || typeof object.defaultBranchRef !== "object") {
    throw new IndexError(`Repository ${nameWithOwner} has no default branch and cannot be launched.`);
  }
  const defaultBranchObject = object.defaultBranchRef as Record<string, unknown>;
  rejectUnknown(defaultBranchObject, ["name"], "repository entry.defaultBranchRef");
  const defaultBranch = requireBranch(defaultBranchObject.name);
  const description = object.description === null ? "" : requireString(object.description, "repository entry.description");
  if (object.isArchived !== undefined && typeof object.isArchived !== "boolean") {
    throw new IndexError("GitHub returned an invalid archive status.");
  }
  if (seen.has(nameWithOwner)) throw new IndexError(`GitHub returned duplicate repository ${nameWithOwner}.`);
  seen.add(nameWithOwner);
  return { nameWithOwner, name, owner, defaultBranch, description };
}

function parseStoredRepositoryEntry(value: unknown, seen: Set<string>): RepositoryIndexEntry {
  const object = requireObject(value, "repository index entry");
  rejectUnknown(object, ["nameWithOwner", "name", "owner", "defaultBranch", "description"], "repository index entry");
  const nameWithOwner = requireRepositoryName(object.nameWithOwner, "repository index entry.nameWithOwner");
  const separator = nameWithOwner.indexOf("/");
  const owner = requireLogin(object.owner, "repository index entry.owner");
  const name = requireRepositoryPart(object.name, "repository index entry.name");
  if (nameWithOwner.slice(0, separator) !== owner || nameWithOwner.slice(separator + 1) !== name) {
    throw new IndexError("The repository index has an inconsistent repository name.");
  }
  const defaultBranch = requireBranch(object.defaultBranch);
  const description = requireString(object.description, "repository index entry.description");
  if (seen.has(nameWithOwner)) throw new IndexError(`The repository index has duplicate repository ${nameWithOwner}.`);
  seen.add(nameWithOwner);
  return { nameWithOwner, name, owner, defaultBranch, description };
}

async function atomicWrite(destination: string, content: string): Promise<void> {
  const temporary = join(dirname(destination), `.index.${process.pid}.${randomUUID()}.tmp`);
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

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new IndexError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function rejectUnknown(object: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new IndexError(`${label} contains an unsupported property.`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new IndexError(`${label} must be a string.`);
  return value;
}

function parseOwner(value: unknown): string {
  const object = requireObject(value, "repository entry.owner");
  rejectUnknown(object, ["id", "login"], "repository entry.owner");
  return requireLogin(object.login, "repository entry.owner.login");
}

function requireLogin(value: unknown, label: string): string {
  const login = requireString(value, label);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37})?$/.test(login)) throw new IndexError(`${label} is invalid.`);
  return login;
}

function requireRepositoryPart(value: unknown, label: string): string {
  const part = requireString(value, label);
  if (!/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === "..") throw new IndexError(`${label} is invalid.`);
  return part;
}

function requireRepositoryName(value: unknown, label: string): string {
  const name = requireString(value, label);
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(name)) throw new IndexError(`${label} is invalid.`);
  return name;
}

function requireBranch(value: unknown): string {
  const branch = requireString(value, "repository entry.defaultBranchRef.name");
  if (branch.startsWith("-") || branch.includes("..") || /[\s~^:?*\\[\\]/.test(branch) || branch.endsWith(".") || branch.endsWith("/")) {
    throw new IndexError("GitHub returned an unsafe default branch name.");
  }
  return branch;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
