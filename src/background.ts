import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  getFlashStateDirectory,
  resolveAgentDirectory,
  type ConfigLocationOptions,
} from "./config.js";

const BACKGROUND_VERSION = 1;
const JOB_KINDS = ["refresh-index", "automatic-cleanup"] as const;
const LOCK_OWNER_FILE = "owner.json";
const ORPHANED_LOCK_GRACE_MS = 30_000;
const LOCK_HEARTBEAT_INTERVAL_MS = 5_000;
const LOCK_HEARTBEAT_STALE_MS = 60_000;
const MAX_SUMMARY_LENGTH = 4_000;

export type BackgroundJobKind = (typeof JOB_KINDS)[number];
export type BackgroundJobStatus = "succeeded" | "failed" | "skipped";

export interface BackgroundRequest {
  version: typeof BACKGROUND_VERSION;
  id: string;
  kind: BackgroundJobKind;
  requestedAt: string;
}

export interface BackgroundJobResult {
  status: Exclude<BackgroundJobStatus, "failed">;
  summary: string;
}

export interface BackgroundEvent {
  version: typeof BACKGROUND_VERSION;
  id: string;
  kind: BackgroundJobKind;
  status: BackgroundJobStatus;
  requestedAt: string;
  startedAt: string;
  finishedAt: string;
  summary: string;
}

export interface BackgroundScheduleResult {
  request: BackgroundRequest;
  coalesced: boolean;
  workerStarted: boolean;
}

export interface BackgroundOptions extends ConfigLocationOptions {
  now?: () => Date;
  id?: () => string;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface BackgroundWorkerOptions extends BackgroundOptions {
  executeJob: (request: BackgroundRequest) => Promise<BackgroundJobResult>;
}

interface ActiveJob {
  version: typeof BACKGROUND_VERSION;
  request: BackgroundRequest;
  pid: number;
  workerToken: string;
  startedAt: string;
}

interface WorkerLock {
  token: string;
  pid: number;
  heartbeat?: NodeJS.Timeout;
}

interface LockOwner extends WorkerLock {
  version: typeof BACKGROUND_VERSION;
  startedAt: string;
  heartbeatAt: string;
}

export class BackgroundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackgroundError";
  }
}

/**
 * Persists a refresh request and starts a detached worker. Repeated pending or
 * active requests coalesce into the same unit of work.
 */
export async function scheduleRepositoryRefresh(options: BackgroundOptions = {}): Promise<BackgroundScheduleResult> {
  return scheduleBackgroundJob("refresh-index", options);
}

/**
 * Persists an automatic-cleanup request and starts a detached worker. The
 * worker re-reads durable configuration before doing any cleanup.
 */
export async function scheduleAutomaticCleanup(options: BackgroundOptions = {}): Promise<BackgroundScheduleResult> {
  return scheduleBackgroundJob("automatic-cleanup", options);
}

export async function scheduleBackgroundJob(
  kind: BackgroundJobKind,
  options: BackgroundOptions = {},
): Promise<BackgroundScheduleResult> {
  const enqueued = await enqueueBackgroundJob(kind, options);
  if (enqueued.active) {
    return { request: enqueued.request, coalesced: true, workerStarted: false };
  }
  const workerStarted = await spawnBackgroundWorker(options);
  if (!workerStarted) {
    throw new BackgroundError("Pi Flash queued the background job but could not start its worker. It will retry the queued job next time Flash is used.");
  }
  return { request: enqueued.request, coalesced: enqueued.coalesced, workerStarted };
}

/**
 * Queue-only primitive used by tests and worker supervisors. Normal extension
 * code should call one of the schedule helpers so a worker is also started.
 */
export async function enqueueBackgroundJob(
  kind: BackgroundJobKind,
  options: BackgroundOptions = {},
): Promise<{ request: BackgroundRequest; coalesced: boolean; active: boolean }> {
  requireJobKind(kind);
  await ensureBackgroundDirectories(options);

  const active = await readActiveJob(kind, options);
  if (active) {
    if (await activeJobIsAlive(active, options)) {
      return { request: active.request, coalesced: true, active: true };
    }
    await unlinkIfSameActive(kind, active.request.id, options);
  }

  const pending = await readRequest(kind, options);
  if (pending) return { request: pending, coalesced: true, active: false };

  const request: BackgroundRequest = {
    version: BACKGROUND_VERSION,
    id: options.id?.() ?? randomUUID(),
    kind,
    requestedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  await atomicWriteJson(getRequestPath(kind, options), request);
  return { request, coalesced: false, active: false };
}

/**
 * Drains all durable requests under one interprocess lock. Returns false when
 * another healthy worker already owns the queue.
 */
export async function runBackgroundWorker(options: BackgroundWorkerOptions): Promise<boolean> {
  let lock = await acquireWorkerLock(options);
  if (!lock) return false;

  try {
    for (;;) {
      let processed = false;
      for (const kind of JOB_KINDS) {
        const request = await readRequest(kind, options);
        if (!request) continue;
        processed = true;
        await processRequest(request, lock, options);
      }
      if (processed) continue;

      await releaseWorkerLock(lock, options);
      lock = undefined;
      if (!(await hasPendingRequests(options))) return true;

      lock = await acquireWorkerLock(options);
      if (!lock) return true;
    }
  } finally {
    if (lock) await releaseWorkerLock(lock, options);
  }
}

export function getBackgroundEventsPath(options: ConfigLocationOptions = {}): string {
  return join(getBackgroundDirectory(options), "events.jsonl");
}

export function getBackgroundWorkerLogPath(options: ConfigLocationOptions = {}): string {
  return join(getBackgroundDirectory(options), "worker.log");
}

export async function readBackgroundEvents(options: ConfigLocationOptions = {}): Promise<BackgroundEvent[]> {
  let content: string;
  try {
    content = await readFile(getBackgroundEventsPath(options), "utf8");
  } catch (error: unknown) {
    if (isNotFound(error)) return [];
    throw new BackgroundError("Could not read Pi Flash background outcomes.", { cause: asError(error) });
  }
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    try {
      return parseEvent(JSON.parse(line));
    } catch (error: unknown) {
      throw new BackgroundError(`Pi Flash background outcome line ${index + 1} is invalid.`, { cause: asError(error) });
    }
  });
}

async function processRequest(
  request: BackgroundRequest,
  lock: WorkerLock,
  options: BackgroundWorkerOptions,
): Promise<void> {
  const startedAt = (options.now?.() ?? new Date()).toISOString();
  await writeActiveJob({
    version: BACKGROUND_VERSION,
    request,
    pid: options.pid ?? process.pid,
    workerToken: lock.token,
    startedAt,
  }, options);

  let event: BackgroundEvent;
  try {
    const result = await options.executeJob(request);
    event = {
      version: BACKGROUND_VERSION,
      id: request.id,
      kind: request.kind,
      status: result.status,
      requestedAt: request.requestedAt,
      startedAt,
      finishedAt: (options.now?.() ?? new Date()).toISOString(),
      summary: normalizeSummary(result.summary),
    };
  } catch (error: unknown) {
    event = {
      version: BACKGROUND_VERSION,
      id: request.id,
      kind: request.kind,
      status: "failed",
      requestedAt: request.requestedAt,
      startedAt,
      finishedAt: (options.now?.() ?? new Date()).toISOString(),
      summary: normalizeSummary(error instanceof Error ? error.message : String(error)),
    };
  }

  // A request is consumed only after its outcome is durable. If the process is
  // interrupted earlier, the request remains available for reconciliation.
  await appendBackgroundEvent(event, options);
  await unlinkIfSameRequest(request.kind, request.id, options);
  await unlinkIfSameActive(request.kind, request.id, options);
}

async function appendBackgroundEvent(event: BackgroundEvent, options: ConfigLocationOptions): Promise<void> {
  await ensureBackgroundDirectories(options);
  const destination = getBackgroundEventsPath(options);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(destination, "a", 0o600);
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(destination, 0o600);
  } catch (error: unknown) {
    throw new BackgroundError("Could not record a Pi Flash background outcome.", { cause: asError(error) });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function spawnBackgroundWorker(options: BackgroundOptions): Promise<boolean> {
  await ensureBackgroundDirectories(options);
  const logPath = getBackgroundWorkerLogPath(options);
  const log = await open(logPath, "a", 0o600);
  await chmod(logPath, 0o600);
  const environment: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: resolveAgentDirectory(options) };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("PI_SESSION_")) delete environment[key];
  }

  try {
    const invocation = getWorkerInvocation();
    const child = spawn(invocation.command, invocation.args, {
      detached: true,
      env: environment,
      stdio: ["ignore", log.fd, log.fd],
    });
    return await new Promise<boolean>((resolve) => {
      child.once("spawn", () => {
        child.unref();
        void log.close();
        resolve(true);
      });
      child.once("error", (error) => {
        void log.writeFile(`${new Date().toISOString()} worker spawn failed: ${error.message}\n`)
          .finally(() => log.close())
          .then(() => resolve(false), () => resolve(false));
      });
    });
  } catch (error: unknown) {
    await log.writeFile(`${new Date().toISOString()} worker spawn failed: ${error instanceof Error ? error.message : String(error)}\n`).catch(() => undefined);
    await log.close().catch(() => undefined);
    return false;
  }
}

function getWorkerInvocation(): { command: string; args: string[] } {
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDirectory = dirname(modulePath);
  const runtimeName = basename(process.execPath).toLowerCase();
  const isBun = runtimeName === "bun" || runtimeName === "bun.exe"
    || "bun" in process.versions;
  const isNode = runtimeName === "node" || runtimeName === "node.exe";
  const runtime = isBun || isNode ? process.execPath : "node";
  const compiledWorker = join(moduleDirectory, "background-worker.mjs");
  if (existsSync(compiledWorker)) return { command: runtime, args: [compiledWorker] };
  const sourceWorker = join(moduleDirectory, "background-worker.ts");
  const sourceLoader = join(moduleDirectory, "typescript-loader.mjs");
  if (!existsSync(sourceWorker) || (!isBun && !existsSync(sourceLoader))) {
    throw new BackgroundError("Could not locate the packaged Pi Flash background worker.");
  }
  if (isBun) return { command: runtime, args: [sourceWorker] };
  return {
    command: runtime,
    args: [
      "--no-warnings",
      "--experimental-transform-types",
      "--experimental-loader",
      pathToFileURL(sourceLoader).href,
      sourceWorker,
    ],
  };
}

async function acquireWorkerLock(options: BackgroundOptions): Promise<WorkerLock | undefined> {
  await ensureBackgroundDirectories(options);
  const lockPath = getWorkerLockPath(options);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const owner: LockOwner = {
        version: BACKGROUND_VERSION,
        token,
        pid: options.pid ?? process.pid,
        startedAt: (options.now?.() ?? new Date()).toISOString(),
        heartbeatAt: (options.now?.() ?? new Date()).toISOString(),
      };
      await atomicWriteJson(join(lockPath, LOCK_OWNER_FILE), owner);
      const lock: WorkerLock = { token, pid: owner.pid };
      lock.heartbeat = setInterval(() => {
        void refreshWorkerHeartbeat(lock, options).catch(() => undefined);
      }, LOCK_HEARTBEAT_INTERVAL_MS);
      lock.heartbeat.unref();
      return lock;
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) {
        throw new BackgroundError("Could not acquire the Pi Flash background worker lock.", { cause: asError(error) });
      }
    }

    if (await lockAppearsAlive(options)) return undefined;
    await quarantineStaleLock(options);
  }
  return undefined;
}

async function releaseWorkerLock(lock: WorkerLock, options: ConfigLocationOptions): Promise<void> {
  if (lock.heartbeat) clearInterval(lock.heartbeat);
  const lockPath = getWorkerLockPath(options);
  let owner: LockOwner;
  try {
    owner = parseLockOwner(JSON.parse(await readFile(join(lockPath, LOCK_OWNER_FILE), "utf8")));
  } catch (error: unknown) {
    if (isNotFound(error)) return;
    throw new BackgroundError("Could not verify the Pi Flash background worker lock.", { cause: asError(error) });
  }
  if (owner.token !== lock.token || owner.pid !== lock.pid) return;
  await rm(lockPath, { recursive: true, force: true });
}

async function lockAppearsAlive(options: BackgroundOptions): Promise<boolean> {
  const lockPath = getWorkerLockPath(options);
  try {
    const owner = parseLockOwner(JSON.parse(await readFile(join(lockPath, LOCK_OWNER_FILE), "utf8")));
    return (options.isProcessAlive ?? isProcessAlive)(owner.pid)
      && Date.now() - Date.parse(owner.heartbeatAt) <= LOCK_HEARTBEAT_STALE_MS;
  } catch (error: unknown) {
    if (!isNotFound(error) && !(error instanceof SyntaxError) && !(error instanceof BackgroundError)) throw error;
    try {
      const details = await stat(lockPath);
      return Date.now() - details.mtimeMs < ORPHANED_LOCK_GRACE_MS;
    } catch (statError: unknown) {
      if (isNotFound(statError)) return false;
      throw statError;
    }
  }
}

async function activeJobIsAlive(active: ActiveJob, options: BackgroundOptions): Promise<boolean> {
  try {
    const owner = parseLockOwner(JSON.parse(await readFile(join(getWorkerLockPath(options), LOCK_OWNER_FILE), "utf8")));
    return owner.token === active.workerToken
      && owner.pid === active.pid
      && (options.isProcessAlive ?? isProcessAlive)(owner.pid)
      && Date.now() - Date.parse(owner.heartbeatAt) <= LOCK_HEARTBEAT_STALE_MS;
  } catch (error: unknown) {
    if (isNotFound(error) || error instanceof SyntaxError || error instanceof BackgroundError) return false;
    throw error;
  }
}

async function refreshWorkerHeartbeat(lock: WorkerLock, options: BackgroundOptions): Promise<void> {
  const ownerPath = join(getWorkerLockPath(options), LOCK_OWNER_FILE);
  let owner: LockOwner;
  try {
    owner = parseLockOwner(JSON.parse(await readFile(ownerPath, "utf8")));
  } catch (error: unknown) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (owner.token !== lock.token || owner.pid !== lock.pid) return;
  await atomicWriteJson(ownerPath, {
    ...owner,
    heartbeatAt: (options.now?.() ?? new Date()).toISOString(),
  });
}

async function quarantineStaleLock(options: ConfigLocationOptions): Promise<void> {
  const lockPath = getWorkerLockPath(options);
  const stalePath = `${lockPath}.stale.${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error: unknown) {
    if (isNotFound(error)) return;
    throw new BackgroundError("Could not quarantine a stale Pi Flash background worker lock.", { cause: asError(error) });
  }
  await rm(stalePath, { recursive: true, force: true });
}

async function hasPendingRequests(options: ConfigLocationOptions): Promise<boolean> {
  for (const kind of JOB_KINDS) {
    if (await readRequest(kind, options)) return true;
  }
  return false;
}

async function readRequest(kind: BackgroundJobKind, options: ConfigLocationOptions): Promise<BackgroundRequest | undefined> {
  try {
    return parseRequest(JSON.parse(await readFile(getRequestPath(kind, options), "utf8")), kind);
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    if (error instanceof BackgroundError) throw error;
    throw new BackgroundError(`Could not read the Pi Flash ${kind} request.`, { cause: asError(error) });
  }
}

async function readActiveJob(kind: BackgroundJobKind, options: ConfigLocationOptions): Promise<ActiveJob | undefined> {
  try {
    return parseActiveJob(JSON.parse(await readFile(getActivePath(kind, options), "utf8")), kind);
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    if (error instanceof BackgroundError) throw error;
    throw new BackgroundError(`Could not read the active Pi Flash ${kind} job.`, { cause: asError(error) });
  }
}

async function writeActiveJob(active: ActiveJob, options: ConfigLocationOptions): Promise<void> {
  await atomicWriteJson(getActivePath(active.request.kind, options), active);
}

async function unlinkIfSameRequest(kind: BackgroundJobKind, id: string, options: ConfigLocationOptions): Promise<void> {
  const current = await readRequest(kind, options);
  if (current?.id !== id) return;
  await unlink(getRequestPath(kind, options)).catch((error: unknown) => {
    if (!isNotFound(error)) throw error;
  });
}

async function unlinkIfSameActive(kind: BackgroundJobKind, id: string, options: ConfigLocationOptions): Promise<void> {
  const current = await readActiveJob(kind, options);
  if (current?.request.id !== id) return;
  await unlink(getActivePath(kind, options)).catch((error: unknown) => {
    if (!isNotFound(error)) throw error;
  });
}

async function ensureBackgroundDirectories(options: ConfigLocationOptions): Promise<void> {
  const stateDirectory = getFlashStateDirectory(options);
  const backgroundDirectory = getBackgroundDirectory(options);
  const requestDirectory = getRequestDirectory(options);
  const activeDirectory = getActiveDirectory(options);
  await mkdir(requestDirectory, { recursive: true, mode: 0o700 });
  await mkdir(activeDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    chmod(stateDirectory, 0o700),
    chmod(backgroundDirectory, 0o700),
    chmod(requestDirectory, 0o700),
    chmod(activeDirectory, 0o700),
  ]);
}

async function atomicWriteJson(destination: string, value: unknown): Promise<void> {
  const temporary = join(dirname(destination), `.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
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

function getBackgroundDirectory(options: ConfigLocationOptions): string {
  return join(getFlashStateDirectory(options), "background");
}

function getRequestDirectory(options: ConfigLocationOptions): string {
  return join(getBackgroundDirectory(options), "requests");
}

function getActiveDirectory(options: ConfigLocationOptions): string {
  return join(getBackgroundDirectory(options), "active");
}

function getRequestPath(kind: BackgroundJobKind, options: ConfigLocationOptions): string {
  return join(getRequestDirectory(options), `${kind}.json`);
}

function getActivePath(kind: BackgroundJobKind, options: ConfigLocationOptions): string {
  return join(getActiveDirectory(options), `${kind}.json`);
}

function getWorkerLockPath(options: ConfigLocationOptions): string {
  return join(getBackgroundDirectory(options), "worker.lock");
}

function parseRequest(value: unknown, expectedKind?: BackgroundJobKind): BackgroundRequest {
  const object = requireObject(value, "background request");
  rejectUnknown(object, ["version", "id", "kind", "requestedAt"], "background request");
  if (object.version !== BACKGROUND_VERSION) throw new BackgroundError("The background request has an unsupported version.");
  const kind = requireJobKind(object.kind);
  if (expectedKind && kind !== expectedKind) throw new BackgroundError("The background request kind does not match its queue.");
  return {
    version: BACKGROUND_VERSION,
    id: requireUuid(object.id, "background request.id"),
    kind,
    requestedAt: requireTimestamp(object.requestedAt, "background request.requestedAt"),
  };
}

function parseActiveJob(value: unknown, expectedKind: BackgroundJobKind): ActiveJob {
  const object = requireObject(value, "active background job");
  rejectUnknown(object, ["version", "request", "pid", "workerToken", "startedAt"], "active background job");
  if (object.version !== BACKGROUND_VERSION) throw new BackgroundError("The active background job has an unsupported version.");
  return {
    version: BACKGROUND_VERSION,
    request: parseRequest(object.request, expectedKind),
    pid: requirePid(object.pid, "active background job.pid"),
    workerToken: requireUuid(object.workerToken, "active background job.workerToken"),
    startedAt: requireTimestamp(object.startedAt, "active background job.startedAt"),
  };
}

function parseLockOwner(value: unknown): LockOwner {
  const object = requireObject(value, "background worker lock");
  rejectUnknown(object, ["version", "token", "pid", "startedAt", "heartbeatAt"], "background worker lock");
  if (object.version !== BACKGROUND_VERSION) throw new BackgroundError("The background worker lock has an unsupported version.");
  return {
    version: BACKGROUND_VERSION,
    token: requireUuid(object.token, "background worker lock.token"),
    pid: requirePid(object.pid, "background worker lock.pid"),
    startedAt: requireTimestamp(object.startedAt, "background worker lock.startedAt"),
    heartbeatAt: requireTimestamp(object.heartbeatAt, "background worker lock.heartbeatAt"),
  };
}

function parseEvent(value: unknown): BackgroundEvent {
  const object = requireObject(value, "background outcome");
  rejectUnknown(object, ["version", "id", "kind", "status", "requestedAt", "startedAt", "finishedAt", "summary"], "background outcome");
  if (object.version !== BACKGROUND_VERSION) throw new BackgroundError("The background outcome has an unsupported version.");
  if (object.status !== "succeeded" && object.status !== "failed" && object.status !== "skipped") {
    throw new BackgroundError("The background outcome has an invalid status.");
  }
  return {
    version: BACKGROUND_VERSION,
    id: requireUuid(object.id, "background outcome.id"),
    kind: requireJobKind(object.kind),
    status: object.status,
    requestedAt: requireTimestamp(object.requestedAt, "background outcome.requestedAt"),
    startedAt: requireTimestamp(object.startedAt, "background outcome.startedAt"),
    finishedAt: requireTimestamp(object.finishedAt, "background outcome.finishedAt"),
    summary: requireString(object.summary, "background outcome.summary"),
  };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BackgroundError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function rejectUnknown(object: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new BackgroundError(`${label} contains an unsupported property.`);
  }
}

function requireJobKind(value: unknown): BackgroundJobKind {
  if (value !== "refresh-index" && value !== "automatic-cleanup") throw new BackgroundError("The background job kind is invalid.");
  return value;
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BackgroundError(`${label} must be a UUID.`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new BackgroundError(`${label} must be a timestamp.`);
  return value;
}

function requirePid(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new BackgroundError(`${label} is invalid.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new BackgroundError(`${label} must be a string.`);
  return value;
}

function normalizeSummary(value: string): string {
  const normalized = value.trim() || "No details were provided.";
  return normalized.length <= MAX_SUMMARY_LENGTH ? normalized : `${normalized.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isMissingProcess(error);
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isMissingProcess(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH";
}

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}
