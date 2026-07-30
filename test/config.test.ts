import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createDefaultConfig,
  getConfigPath,
  parseConfig,
  readConfig,
  resolveAgentDirectory,
  validateWorkspaceRoot,
  writeConfig,
} from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Pi Flash configuration", () => {
  it("uses the documented defaults and resolves the Pi agent directory", () => {
    const homeDirectory = "/example/home";

    expect(createDefaultConfig({ homeDirectory })).toEqual({
      version: 1,
      host: "github.com",
      workspaceRoot: "/example/home/dev",
      sources: {},
      branchNamespace: null,
      matching: {
        autoLaunchThreshold: 0.82,
        minimumLeadOverSecond: 0.08,
        resultsShownWhenAmbiguous: 8,
      },
      index: { maxAgeHours: 24 },
      fetch: { attempts: 3, timeoutSeconds: 30, initialBackoffMilliseconds: 500 },
      cleanup: { enabled: false, inactiveAfterDays: 14, untrackedFiles: "block", ignoredFiles: "block" },
    });
    expect(resolveAgentDirectory({ homeDirectory, environment: {} })).toBe("/example/home/.pi/agent");
    expect(resolveAgentDirectory({ homeDirectory, environment: { PI_CODING_AGENT_DIR: "~/custom-pi" } })).toBe("/example/home/custom-pi");
  });

  it("fills absent v1 values while retaining explicitly configured values", () => {
    const config = parseConfig({
      version: 1,
      workspaceRoot: "~/workspaces",
      sources: { octo: true, "example-org": false },
      matching: { autoLaunchThreshold: 0.9 },
      cleanup: { untrackedFiles: "include-unignored" },
    }, { homeDirectory: "/example/home", cwd: "/irrelevant" });

    expect(config.workspaceRoot).toBe("/example/home/workspaces");
    expect(config.sources).toEqual({ octo: true, "example-org": false });
    expect(config.matching).toEqual({
      autoLaunchThreshold: 0.9,
      minimumLeadOverSecond: 0.08,
      resultsShownWhenAmbiguous: 8,
    });
    expect(config.cleanup).toEqual({
      enabled: false,
      inactiveAfterDays: 14,
      untrackedFiles: "include-unignored",
      ignoredFiles: "block",
    });
  });

  it.each([
    [{}, "configuration.version"],
    [{ version: 2 }, "newer"],
    [{ version: 0 }, "cannot be migrated"],
    [{ version: 1, unexpected: true }, "unsupported property"],
    [{ version: 1, host: "github.example" }, "github.com"],
    [{ version: 1, sources: { "not/valid": true } }, "invalid GitHub owner"],
    [{ version: 1, sources: { octo: "yes" } }, "must be a boolean"],
    [{ version: 1, branchNamespace: "bad/name" }, "safe Git branch namespace"],
    [{ version: 1, matching: { autoLaunchThreshold: 1.1 } }, "number from 0 to 1"],
    [{ version: 1, matching: { unknown: 1 } }, "unsupported property"],
    [{ version: 1, fetch: { attempts: 0 } }, "integer from 1 to 10"],
    [{ version: 1, cleanup: { untrackedFiles: "everything" } }, "must be one of"],
  ])("rejects malformed configuration %#", (value, message) => {
    expect(() => parseConfig(value, { homeDirectory: "/example/home" })).toThrow(message);
  });

  it("distinguishes a newer configuration version", () => {
    expect(() => parseConfig({ version: 99 }, { homeDirectory: "/example/home" })).toThrowError(
      expect.objectContaining({ code: "unsupported-version" }),
    );
  });

  it("creates a missing workspace only when explicitly allowed", async () => {
    const sandbox = await createSandbox();
    const target = join(sandbox.homeDirectory, "projects");

    await expect(validateWorkspaceRoot(target, sandbox.workspaceOptions)).rejects.toMatchObject({
      code: "workspace-root-missing",
    });
    const canonicalRoot = await validateWorkspaceRoot(target, { ...sandbox.workspaceOptions, createIfMissing: true });
    expect(canonicalRoot).toBe(await realpath(target));
    await expect(stat(target)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("rejects filesystem, home, agent, non-directory, and forbidden symlink workspace roots", async () => {
    const sandbox = await createSandbox();
    const file = join(sandbox.homeDirectory, "not-a-directory");
    await writeFile(file, "x");
    const homeLink = join(sandbox.homeDirectory, "home-link");
    const agentLink = join(sandbox.homeDirectory, "agent-link");
    await symlink(sandbox.homeDirectory, homeLink);
    await symlink(sandbox.agentDirectory, agentLink);

    await expect(validateWorkspaceRoot("/", sandbox.workspaceOptions)).rejects.toMatchObject({ code: "invalid-workspace-root" });
    await expect(validateWorkspaceRoot(sandbox.homeDirectory, sandbox.workspaceOptions)).rejects.toThrow("home directory");
    await expect(validateWorkspaceRoot(sandbox.agentDirectory, sandbox.workspaceOptions)).rejects.toThrow("agent directory");
    await expect(validateWorkspaceRoot(join(sandbox.homeDirectory, ".pi"), sandbox.workspaceOptions)).rejects.toThrow("agent directory");
    await expect(validateWorkspaceRoot(file, sandbox.workspaceOptions)).rejects.toThrow("not a directory");
    await expect(validateWorkspaceRoot(homeLink, sandbox.workspaceOptions)).rejects.toThrow("home directory");
    await expect(validateWorkspaceRoot(agentLink, sandbox.workspaceOptions)).rejects.toThrow("agent directory");
  });

  it("returns undefined when absent and errors rather than accepting malformed or newer saved configuration", async () => {
    const sandbox = await createSandbox();
    const configPath = getConfigPath(sandbox.configOptions);

    await expect(readConfig(sandbox.configOptions)).resolves.toBeUndefined();
    await mkdir(join(sandbox.agentDirectory, "pi-flash"), { recursive: true });
    await writeFile(configPath, "{");
    await expect(readConfig(sandbox.configOptions)).rejects.toMatchObject({ code: "invalid-config" });

    await writeFile(configPath, JSON.stringify({ version: 2 }));
    await expect(readConfig(sandbox.configOptions)).rejects.toMatchObject({ code: "unsupported-version" });
  });

  it("writes canonical configuration atomically with private permissions", async () => {
    const sandbox = await createSandbox();
    const configuredRoot = join(sandbox.homeDirectory, "chosen-workspace");
    const config = { ...createDefaultConfig({ homeDirectory: sandbox.homeDirectory }), workspaceRoot: configuredRoot };

    await expect(writeConfig(config, sandbox.configOptions)).rejects.toMatchObject({ code: "workspace-root-missing" });
    const persisted = await writeConfig(config, { ...sandbox.configOptions, createWorkspaceRoot: true });

    expect(persisted.workspaceRoot).toBe(await realpath(configuredRoot));
    await expect(readConfig(sandbox.configOptions)).resolves.toEqual(persisted);
    expect(JSON.parse(await readFile(getConfigPath(sandbox.configOptions), "utf8"))).toEqual(persisted);
    expect((await stat(join(sandbox.agentDirectory, "pi-flash"))).mode & 0o777).toBe(0o700);
    expect((await stat(getConfigPath(sandbox.configOptions))).mode & 0o777).toBe(0o600);
  });

  it("never exposes a partially written configuration to concurrent readers and writers", async () => {
    const sandbox = await createSandbox();
    const workspaceRoot = join(sandbox.homeDirectory, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const values = Array.from({ length: 20 }, (_, index) => index + 10);

    const writers = values.map(async (timeoutSeconds) => {
      const config = createDefaultConfig({ homeDirectory: sandbox.homeDirectory });
      config.workspaceRoot = workspaceRoot;
      config.fetch.timeoutSeconds = timeoutSeconds;
      await writeConfig(config, sandbox.configOptions);
    });
    const readers = Array.from({ length: 40 }, async () => {
      const config = await readConfig(sandbox.configOptions);
      if (config !== undefined) {
        expect(values).toContain(config.fetch.timeoutSeconds);
      }
    });

    await Promise.all([...writers, ...readers]);

    const persisted = await readConfig(sandbox.configOptions);
    expect(persisted).toBeDefined();
    expect(values).toContain(persisted?.fetch.timeoutSeconds);
    await expect(readFile(getConfigPath(sandbox.configOptions), "utf8")).resolves.toSatisfy((content) => {
      expect(() => JSON.parse(content)).not.toThrow();
      return true;
    });
  });
});

async function createSandbox(): Promise<{
  homeDirectory: string;
  agentDirectory: string;
  configOptions: { homeDirectory: string; agentDirectory: string };
  workspaceOptions: { homeDirectory: string; agentDirectory: string };
}> {
  const directory = await mkdtemp(join(tmpdir(), "pi-flash-config-"));
  temporaryDirectories.push(directory);
  const homeDirectory = join(directory, "home");
  const agentDirectory = join(homeDirectory, ".pi", "agent");
  await mkdir(agentDirectory, { recursive: true });

  return {
    homeDirectory,
    agentDirectory,
    configOptions: { homeDirectory, agentDirectory },
    workspaceOptions: { homeDirectory, agentDirectory },
  };
}
