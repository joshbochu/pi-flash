import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import { getFlashStateDirectory, type ConfigLocationOptions } from "./config.js";
import type { WorkspacePreparation } from "./git-workspace.js";
import type { RepositoryIndexEntry } from "./index-store.js";
import type { WorktreeRecord } from "./registry.js";

export const HISTORY_VERSION = 1;

export type HistoryEvent = "worktree-created" | "handoff-scheduled" | "stale-fallback" | "cleanup-proposed" | "cleanup-skipped" | "parked" | "removed" | "failure";

export interface HistoryEntry {
  version: typeof HISTORY_VERSION;
  at: string;
  event: HistoryEvent;
  metadata: Record<string, string | number | boolean | null>;
}

export class HistoryError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HistoryError";
  }
}

export function getHistoryPath(options: ConfigLocationOptions = {}): string {
  return join(getFlashStateDirectory(options), "history.jsonl");
}

/** Appends one compact, credential-free audit event. */
export async function appendHistory(entry: HistoryEntry, options: ConfigLocationOptions = {}): Promise<void> {
  const parsed = parseHistoryEntry(entry);
  const stateDirectory = getFlashStateDirectory(options);
  const historyPath = getHistoryPath(options);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(stateDirectory, 0o700);
    handle = await open(historyPath, "a", 0o600);
    await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(historyPath, 0o600);
  } catch (error: unknown) {
    throw new HistoryError("Could not append Pi Flash history.", { cause: error instanceof Error ? error : undefined });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readHistory(options: ConfigLocationOptions = {}): Promise<HistoryEntry[]> {
  let content: string;
  try {
    content = await readFile(getHistoryPath(options), "utf8");
  } catch (error: unknown) {
    if (isNotFound(error)) return [];
    throw new HistoryError("Could not read Pi Flash history.", { cause: error instanceof Error ? error : undefined });
  }
  if (content === "") return [];
  return content.split("\n").filter((line) => line.length > 0).map((line, index) => {
    try {
      return parseHistoryEntry(JSON.parse(line));
    } catch (error: unknown) {
      throw new HistoryError(`Pi Flash history line ${index + 1} is invalid. It was not used for cleanup.`, { cause: error instanceof Error ? error : undefined });
    }
  });
}

export async function recordCreatedWorktree(
  record: WorktreeRecord,
  repository: RepositoryIndexEntry,
  workspace: WorkspacePreparation,
  options: ConfigLocationOptions & { now?: () => Date } = {},
): Promise<void> {
  const at = (options.now?.() ?? new Date()).toISOString();
  await appendHistory({
    version: HISTORY_VERSION,
    at,
    event: "worktree-created",
    metadata: {
      id: record.id,
      repo: repository.nameWithOwner,
      branch: workspace.branch,
      path: workspace.worktreePath,
      baseSha: workspace.baseSha,
      stale: workspace.stale,
    },
  }, options);
  if (workspace.stale) {
    await appendHistory({
      version: HISTORY_VERSION,
      at,
      event: "stale-fallback",
      metadata: { id: record.id, repo: repository.nameWithOwner, baseSha: workspace.baseSha, fetchedAt: workspace.lastFetchedAt, attempts: workspace.attempts },
    }, options);
  }
}

export function parseHistoryEntry(value: unknown): HistoryEntry {
  const object = requireObject(value, "history entry");
  rejectUnknown(object, ["version", "at", "event", "metadata"], "history entry");
  if (object.version !== HISTORY_VERSION) throw new HistoryError("History entry version is incompatible.");
  if (typeof object.at !== "string" || Number.isNaN(Date.parse(object.at))) throw new HistoryError("History entry timestamp is invalid.");
  if (!isHistoryEvent(object.event)) throw new HistoryError("History entry event is invalid.");
  const metadataObject = requireObject(object.metadata, "history entry metadata");
  const metadata: HistoryEntry["metadata"] = {};
  for (const [key, item] of Object.entries(metadataObject)) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new HistoryError("History metadata key is invalid.");
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean" && item !== null) {
      throw new HistoryError("History metadata must contain primitive values only.");
    }
    if (typeof item === "number" && !Number.isFinite(item)) throw new HistoryError("History metadata number is invalid.");
    metadata[key] = item;
  }
  return { version: HISTORY_VERSION, at: object.at, event: object.event, metadata };
}

function isHistoryEvent(value: unknown): value is HistoryEvent {
  return value === "worktree-created" || value === "handoff-scheduled" || value === "stale-fallback" || value === "cleanup-proposed" || value === "cleanup-skipped" || value === "parked" || value === "removed" || value === "failure";
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HistoryError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function rejectUnknown(object: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new HistoryError(`${label} contains an unsupported property.`);
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
