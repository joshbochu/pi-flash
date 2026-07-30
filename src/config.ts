import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";

/** The only configuration schema understood by this release. */
export const CONFIG_VERSION = 1;

const FLASH_DIRECTORY_NAME = "pi-flash";
const CONFIG_FILE_NAME = "config.json";
const GITHUB_OWNER_PATTERN = /^(?=.{1,39}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const BRANCH_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type UntrackedFilesPolicy = "block" | "include-unignored";
export type IgnoredFilesPolicy = "block" | "discard";

export interface MatchingConfig {
  autoLaunchThreshold: number;
  minimumLeadOverSecond: number;
  resultsShownWhenAmbiguous: number;
}

export interface IndexConfig {
  maxAgeHours: number;
}

export interface FetchConfig {
  attempts: number;
  timeoutSeconds: number;
  initialBackoffMilliseconds: number;
}

export interface CleanupConfig {
  enabled: boolean;
  inactiveAfterDays: number;
  untrackedFiles: UntrackedFilesPolicy;
  ignoredFiles: IgnoredFilesPolicy;
}

/**
 * Global Pi Flash settings. `workspaceRoot` is always stored as a canonical,
 * absolute path, never as a `~`-prefixed value.
 */
export interface Config {
  version: typeof CONFIG_VERSION;
  host: "github.com";
  workspaceRoot: string;
  sources: Record<string, boolean>;
  branchNamespace: string | null;
  matching: MatchingConfig;
  index: IndexConfig;
  fetch: FetchConfig;
  cleanup: CleanupConfig;
}

export type ConfigErrorCode =
  | "invalid-config"
  | "unsupported-version"
  | "invalid-workspace-root"
  | "workspace-root-missing"
  | "config-read-failed"
  | "config-write-failed";

/** A user-actionable configuration or storage error. */
export class ConfigError extends Error {
  public readonly code: ConfigErrorCode;

  public constructor(code: ConfigErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
    this.code = code;
  }
}

export interface ConfigLocationOptions {
  /** Overrides `PI_CODING_AGENT_DIR`; useful for embedding and tests. */
  agentDirectory?: string;
  /** Overrides the process home directory; useful for embedding and tests. */
  homeDirectory?: string;
  /** Overrides the environment consulted for `PI_CODING_AGENT_DIR`. */
  environment?: NodeJS.ProcessEnv;
}

export interface WorkspaceRootOptions extends ConfigLocationOptions {
  /** Relative paths are resolved from this directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Create a missing root only when the caller explicitly opts in. */
  createIfMissing?: boolean;
}

export interface WriteConfigOptions extends ConfigLocationOptions {
  /**
   * Setup passes this option after the user has chosen a path. Routine writes
   * intentionally leave a missing workspace untouched.
   */
  createWorkspaceRoot?: boolean;
}

/** Returns the canonical default value set for a particular home directory. */
export function createDefaultConfig(options: Pick<ConfigLocationOptions, "homeDirectory"> = {}): Config {
  const homeDirectory = resolveHomeDirectory(options.homeDirectory);

  return {
    version: CONFIG_VERSION,
    host: "github.com",
    workspaceRoot: join(homeDirectory, "dev"),
    sources: {},
    branchNamespace: null,
    matching: {
      autoLaunchThreshold: 0.82,
      minimumLeadOverSecond: 0.08,
      resultsShownWhenAmbiguous: 8,
    },
    index: { maxAgeHours: 24 },
    fetch: {
      attempts: 3,
      timeoutSeconds: 30,
      initialBackoffMilliseconds: 500,
    },
    cleanup: {
      enabled: false,
      inactiveAfterDays: 14,
      untrackedFiles: "block",
      ignoredFiles: "block",
    },
  };
}

/** Resolves the Pi state location without creating it. */
export function resolveAgentDirectory(options: ConfigLocationOptions = {}): string {
  const homeDirectory = resolveHomeDirectory(options.homeDirectory);
  const configuredDirectory = options.agentDirectory ?? (options.environment ?? process.env).PI_CODING_AGENT_DIR;

  if (configuredDirectory === undefined || configuredDirectory.trim() === "") {
    return join(homeDirectory, ".pi", "agent");
  }

  return resolveUserPath(configuredDirectory, homeDirectory, process.cwd());
}

/** Returns the directory which owns Pi Flash's durable state. */
export function getFlashStateDirectory(options: ConfigLocationOptions = {}): string {
  return join(resolveAgentDirectory(options), FLASH_DIRECTORY_NAME);
}

/** Returns the absolute path to Pi Flash's global configuration file. */
export function getConfigPath(options: ConfigLocationOptions = {}): string {
  return join(getFlashStateDirectory(options), CONFIG_FILE_NAME);
}

/**
 * Strictly parses an untrusted JSON value and fills documented v1 defaults.
 * It intentionally performs no filesystem I/O; call validateWorkspaceRoot
 * before persisting or using the result.
 */
export function parseConfig(value: unknown, options: Pick<WorkspaceRootOptions, "homeDirectory" | "cwd"> = {}): Config {
  const object = requireObject(value, "configuration");
  rejectUnknownKeys(object, [
    "version",
    "host",
    "workspaceRoot",
    "sources",
    "branchNamespace",
    "matching",
    "index",
    "fetch",
    "cleanup",
  ], "configuration");

  const version = requireInteger(object.version, "configuration.version");
  if (version > CONFIG_VERSION) {
    throw new ConfigError(
      "unsupported-version",
      `Pi Flash configuration version ${version} is newer than this extension supports (version ${CONFIG_VERSION}). Update Pi Flash before continuing.`,
    );
  }
  if (version !== CONFIG_VERSION) {
    throw new ConfigError(
      "unsupported-version",
      `Pi Flash configuration version ${version} cannot be migrated by this release. Re-run /flash setup after backing up the configuration.`,
    );
  }

  const defaults = createDefaultConfig({ homeDirectory: options.homeDirectory });
  const homeDirectory = resolveHomeDirectory(options.homeDirectory);
  const cwd = options.cwd ?? process.cwd();

  const workspaceRoot = object.workspaceRoot === undefined
    ? defaults.workspaceRoot
    : resolveUserPath(requireString(object.workspaceRoot, "configuration.workspaceRoot"), homeDirectory, cwd);

  const host = object.host === undefined ? defaults.host : requireString(object.host, "configuration.host");
  if (host !== "github.com") {
    throw invalidConfig("configuration.host must be \"github.com\" in this release");
  }

  const sources = object.sources === undefined ? defaults.sources : parseSources(object.sources);
  const branchNamespace = object.branchNamespace === undefined
    ? defaults.branchNamespace
    : parseBranchNamespace(object.branchNamespace);

  const matching = parseMatching(object.matching, defaults.matching);
  const index = parseIndex(object.index, defaults.index);
  const fetch = parseFetch(object.fetch, defaults.fetch);
  const cleanup = parseCleanup(object.cleanup, defaults.cleanup);

  return {
    version: CONFIG_VERSION,
    host,
    workspaceRoot,
    sources,
    branchNamespace,
    matching,
    index,
    fetch,
    cleanup,
  };
}

/**
 * Resolves a user-selected root and protects state directories from accidental
 * use. Existing symlinks are followed before comparison, so a symlink to home,
 * the agent directory, or `/` cannot bypass the safety checks.
 */
export async function validateWorkspaceRoot(input: string, options: WorkspaceRootOptions = {}): Promise<string> {
  const homeDirectory = resolveHomeDirectory(options.homeDirectory);
  const agentDirectory = resolveAgentDirectory({
    agentDirectory: options.agentDirectory,
    homeDirectory,
    environment: options.environment,
  });
  const candidate = resolveUserPath(input, homeDirectory, options.cwd ?? process.cwd());

  if (candidate === parsePath(candidate).root) {
    throw invalidWorkspaceRoot("the filesystem root cannot be used as a workspace root");
  }
  // Catch direct forbidden paths before an opted-in creation can touch them.
  // Canonical checks below catch the same cases when symlinks are involved.
  if (candidate === homeDirectory) {
    throw invalidWorkspaceRoot("the home directory cannot be used as a workspace root");
  }
  if (pathsOverlap(candidate, agentDirectory)) {
    throw invalidWorkspaceRoot("the Pi agent directory cannot be used as or inside a workspace root");
  }

  let candidateStats: Awaited<ReturnType<typeof stat>>;
  try {
    candidateStats = await stat(candidate);
  } catch (error: unknown) {
    if (!isNotFound(error)) {
      throw workspaceIoError(candidate, error);
    }
    if (!options.createIfMissing) {
      throw new ConfigError(
        "workspace-root-missing",
        `Workspace root ${candidate} does not exist. Choose an existing directory or allow setup to create it.`,
      );
    }

    try {
      await mkdir(candidate, { recursive: true, mode: 0o700 });
      candidateStats = await stat(candidate);
    } catch (createError: unknown) {
      throw workspaceIoError(candidate, createError);
    }
  }

  if (!candidateStats.isDirectory()) {
    throw invalidWorkspaceRoot(`${candidate} is not a directory`);
  }

  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch (error: unknown) {
    throw workspaceIoError(candidate, error);
  }

  const canonicalHome = await canonicalizeComparisonPath(homeDirectory);
  const canonicalAgentDirectory = await canonicalizeComparisonPath(agentDirectory);
  const filesystemRoot = parsePath(canonicalCandidate).root;

  if (canonicalCandidate === filesystemRoot) {
    throw invalidWorkspaceRoot("the filesystem root cannot be used as a workspace root");
  }
  if (canonicalCandidate === canonicalHome) {
    throw invalidWorkspaceRoot("the home directory cannot be used as a workspace root");
  }
  if (pathsOverlap(canonicalCandidate, canonicalAgentDirectory)) {
    throw invalidWorkspaceRoot("the Pi agent directory cannot be used as or inside a workspace root");
  }

  return canonicalCandidate;
}

/** Reads and validates the saved configuration, or `undefined` before setup. */
export async function readConfig(options: ConfigLocationOptions = {}): Promise<Config | undefined> {
  const configPath = getConfigPath(options);
  let content: string;

  try {
    content = await readFile(configPath, "utf8");
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw new ConfigError("config-read-failed", `Could not read Pi Flash configuration at ${configPath}.`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error: unknown) {
    throw new ConfigError("invalid-config", `Pi Flash configuration at ${configPath} is not valid JSON. Re-run /flash setup after fixing or removing it.`, { cause: error });
  }

  const config = parseConfig(value, { homeDirectory: options.homeDirectory });
  const workspaceRoot = await validateWorkspaceRoot(config.workspaceRoot, {
    agentDirectory: options.agentDirectory,
    homeDirectory: options.homeDirectory,
    environment: options.environment,
    createIfMissing: false,
  });

  return { ...config, workspaceRoot };
}

/**
 * Validates and atomically persists configuration. The root is only created
 * when `createWorkspaceRoot` is set, which keeps ordinary config edits from
 * creating an unexpected directory.
 */
export async function writeConfig(config: Config, options: WriteConfigOptions = {}): Promise<Config> {
  const parsedConfig = parseConfig(config, { homeDirectory: options.homeDirectory });
  const workspaceRoot = await validateWorkspaceRoot(parsedConfig.workspaceRoot, {
    agentDirectory: options.agentDirectory,
    homeDirectory: options.homeDirectory,
    environment: options.environment,
    createIfMissing: options.createWorkspaceRoot ?? false,
  });
  const canonicalConfig = { ...parsedConfig, workspaceRoot };
  const stateDirectory = getFlashStateDirectory(options);
  const configPath = join(stateDirectory, CONFIG_FILE_NAME);

  try {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(stateDirectory, 0o700);
    await atomicWrite(configPath, `${JSON.stringify(canonicalConfig, null, 2)}\n`);
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError("config-write-failed", `Could not write Pi Flash configuration at ${configPath}.`, { cause: error });
  }

  return canonicalConfig;
}

async function atomicWrite(destination: string, content: string): Promise<void> {
  const temporaryPath = join(dirname(destination), `.${CONFIG_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, destination);
    await chmod(destination, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isNotFound(error)) {
        throw error;
      }
    });
  }
}

function parseSources(value: unknown): Record<string, boolean> {
  const object = requireObject(value, "configuration.sources");
  const result: Record<string, boolean> = {};

  for (const [owner, enabled] of Object.entries(object)) {
    if (!GITHUB_OWNER_PATTERN.test(owner)) {
      throw invalidConfig(`configuration.sources contains an invalid GitHub owner: ${JSON.stringify(owner)}`);
    }
    if (typeof enabled !== "boolean") {
      throw invalidConfig(`configuration.sources.${owner} must be a boolean`);
    }
    result[owner] = enabled;
  }

  return result;
}

function parseBranchNamespace(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  const namespace = requireString(value, "configuration.branchNamespace");
  if (!BRANCH_NAMESPACE_PATTERN.test(namespace) || namespace.includes("..") || namespace.endsWith(".")) {
    throw invalidConfig("configuration.branchNamespace is not a safe Git branch namespace");
  }
  return namespace;
}

function parseMatching(value: unknown, defaults: MatchingConfig): MatchingConfig {
  const object = value === undefined ? {} : requireObject(value, "configuration.matching");
  rejectUnknownKeys(object, ["autoLaunchThreshold", "minimumLeadOverSecond", "resultsShownWhenAmbiguous"], "configuration.matching");

  return {
    autoLaunchThreshold: optionalNumber(object.autoLaunchThreshold, defaults.autoLaunchThreshold, "configuration.matching.autoLaunchThreshold", 0, 1),
    minimumLeadOverSecond: optionalNumber(object.minimumLeadOverSecond, defaults.minimumLeadOverSecond, "configuration.matching.minimumLeadOverSecond", 0, 1),
    resultsShownWhenAmbiguous: optionalInteger(object.resultsShownWhenAmbiguous, defaults.resultsShownWhenAmbiguous, "configuration.matching.resultsShownWhenAmbiguous", 1, 100),
  };
}

function parseIndex(value: unknown, defaults: IndexConfig): IndexConfig {
  const object = value === undefined ? {} : requireObject(value, "configuration.index");
  rejectUnknownKeys(object, ["maxAgeHours"], "configuration.index");
  return { maxAgeHours: optionalInteger(object.maxAgeHours, defaults.maxAgeHours, "configuration.index.maxAgeHours", 1, 8760) };
}

function parseFetch(value: unknown, defaults: FetchConfig): FetchConfig {
  const object = value === undefined ? {} : requireObject(value, "configuration.fetch");
  rejectUnknownKeys(object, ["attempts", "timeoutSeconds", "initialBackoffMilliseconds"], "configuration.fetch");

  return {
    attempts: optionalInteger(object.attempts, defaults.attempts, "configuration.fetch.attempts", 1, 10),
    timeoutSeconds: optionalInteger(object.timeoutSeconds, defaults.timeoutSeconds, "configuration.fetch.timeoutSeconds", 1, 300),
    initialBackoffMilliseconds: optionalInteger(object.initialBackoffMilliseconds, defaults.initialBackoffMilliseconds, "configuration.fetch.initialBackoffMilliseconds", 0, 60_000),
  };
}

function parseCleanup(value: unknown, defaults: CleanupConfig): CleanupConfig {
  const object = value === undefined ? {} : requireObject(value, "configuration.cleanup");
  rejectUnknownKeys(object, ["enabled", "inactiveAfterDays", "untrackedFiles", "ignoredFiles"], "configuration.cleanup");

  const untrackedFiles = object.untrackedFiles === undefined
    ? defaults.untrackedFiles
    : requireOneOf(object.untrackedFiles, ["block", "include-unignored"], "configuration.cleanup.untrackedFiles");
  const ignoredFiles = object.ignoredFiles === undefined
    ? defaults.ignoredFiles
    : requireOneOf(object.ignoredFiles, ["block", "discard"], "configuration.cleanup.ignoredFiles");

  return {
    enabled: object.enabled === undefined ? defaults.enabled : requireBoolean(object.enabled, "configuration.cleanup.enabled"),
    inactiveAfterDays: optionalInteger(object.inactiveAfterDays, defaults.inactiveAfterDays, "configuration.cleanup.inactiveAfterDays", 1, 3650),
    untrackedFiles,
    ignoredFiles,
  };
}

function resolveHomeDirectory(homeDirectory: string | undefined): string {
  const candidate = homeDirectory ?? homedir();
  if (candidate.trim() === "") {
    throw invalidConfig("The home directory is empty; set PI_CODING_AGENT_DIR explicitly before using Pi Flash.");
  }
  return resolve(candidate);
}

function resolveUserPath(input: string, homeDirectory: string, cwd: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw invalidWorkspaceRoot("a workspace path must be a non-empty string");
  }
  if (input.includes("\0")) {
    throw invalidWorkspaceRoot("a workspace path cannot contain a NUL byte");
  }

  let expanded = input;
  if (input === "~") {
    expanded = homeDirectory;
  } else if (input.startsWith(`~${sep}`)) {
    expanded = join(homeDirectory, input.slice(2));
  } else if (input.startsWith("~")) {
    throw invalidWorkspaceRoot("only the current user's home directory (~) may be expanded");
  }

  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

async function canonicalizeComparisonPath(input: string): Promise<string> {
  try {
    return await realpath(input);
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return resolve(input);
    }
    throw workspaceIoError(input, error);
  }
}

function pathsOverlap(first: string, second: string): boolean {
  return first === second || isPathInside(first, second) || isPathInside(second, first);
}

function isPathInside(candidate: string, ancestor: string): boolean {
  const difference = relative(ancestor, candidate);
  return difference !== "" && !difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidConfig(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(object: Record<string, unknown>, allowedKeys: readonly string[], label: string): void {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.includes(key)) {
      throw invalidConfig(`${label} contains an unsupported property: ${JSON.stringify(key)}`);
    }
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidConfig(`${label} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidConfig(`${label} must be a boolean`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalidConfig(`${label} must be an integer`);
  }
  return value;
}

function optionalNumber(value: unknown, fallback: number, label: string, minimum: number, maximum: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidConfig(`${label} must be a number from ${minimum} to ${maximum}`);
  }
  return value;
}

function optionalInteger(value: unknown, fallback: number, label: string, minimum: number, maximum: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = requireInteger(value, label);
  if (parsed < minimum || parsed > maximum) {
    throw invalidConfig(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function requireOneOf<const Value extends string>(value: unknown, allowed: readonly Value[], label: string): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    throw invalidConfig(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as Value;
}

function invalidConfig(message: string): ConfigError {
  return new ConfigError("invalid-config", message);
}

function invalidWorkspaceRoot(message: string): ConfigError {
  return new ConfigError("invalid-workspace-root", `Invalid workspace root: ${message}`);
}

function workspaceIoError(path: string, cause: unknown): ConfigError {
  return new ConfigError("invalid-workspace-root", `Could not validate workspace root ${path}.`, { cause: cause instanceof Error ? cause : undefined });
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
