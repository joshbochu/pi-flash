import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  IndexError,
  enabledSourceOwners,
  getIndexPath,
  isIndexStale,
  parseRepositoryIndex,
  readRepositoryIndex,
  refreshRepositoryIndex,
  writeRepositoryIndex,
} from "../src/index-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("repository index", () => {
  it("parses a strict, complete repository cache", () => {
    expect(parseRepositoryIndex({
      version: 1,
      refreshedAt: "2026-07-30T00:00:00.000Z",
      repos: [storedRepository("octo", "flash")],
    })).toEqual({
      version: 1,
      refreshedAt: "2026-07-30T00:00:00.000Z",
      repos: [{ nameWithOwner: "octo/flash", owner: "octo", name: "flash", defaultBranch: "main", description: "A test repository" }],
    });
  });

  it.each([
    [{ version: 2, refreshedAt: "2026-07-30T00:00:00.000Z", repos: [] }],
    [{ version: 1, refreshedAt: "not a date", repos: [] }],
    [{ version: 1, refreshedAt: "2026-07-30T00:00:00.000Z", repos: [repository("octo", "flash"), repository("octo", "flash")] }],
    [{ version: 1, refreshedAt: "2026-07-30T00:00:00.000Z", repos: [{ ...repository("octo", "flash"), defaultBranchRef: null }] }],
  ])("rejects malformed cached data", (value) => {
    expect(() => parseRepositoryIndex(value)).toThrow(IndexError);
  });

  it("keeps a prior complete cache when any configured source fails", async () => {
    const sandbox = await createSandbox();
    const previous = {
      version: 1 as const,
      refreshedAt: "2026-07-30T00:00:00.000Z",
      repos: [{ nameWithOwner: "old/repo", owner: "old", name: "repo", defaultBranch: "main", description: "" }],
    };
    await writeRepositoryIndex(previous, sandbox.options);

    await expect(refreshRepositoryIndex(["octo", "broken"], {
      ...sandbox.options,
      listRepositories: async (owner) => {
        if (owner === "broken") throw new Error("network unavailable");
        return [repository(owner, "flash")];
      },
    })).rejects.toThrow("network unavailable");

    await expect(readRepositoryIndex(sandbox.options)).resolves.toEqual(previous);
  });

  it("refreshes every enabled source, filters archived repositories, and writes private JSON", async () => {
    const sandbox = await createSandbox();
    const calls: string[] = [];
    const refreshed = await refreshRepositoryIndex(["octo", "acme", "octo"], {
      ...sandbox.options,
      now: () => new Date("2026-07-30T12:00:00.000Z"),
      listRepositories: async (owner) => {
        calls.push(owner);
        return [repository(owner, owner === "acme" ? "billing" : "flash"), { ...repository(owner, "archived"), isArchived: true }];
      },
    });

    expect(calls).toEqual(["acme", "octo"]);
    expect(refreshed.repos.map((entry) => entry.nameWithOwner)).toEqual(["acme/billing", "octo/flash"]);
    expect(await readRepositoryIndex(sandbox.options)).toEqual(refreshed);
    expect(JSON.parse(await readFile(getIndexPath(sandbox.options), "utf8"))).toEqual(refreshed);
    expect((await stat(getIndexPath(sandbox.options))).mode & 0o777).toBe(0o600);
  });

  it("skips empty repositories without failing the rest of an owner refresh", async () => {
    const sandbox = await createSandbox();
    const refreshed = await refreshRepositoryIndex(["octo"], {
      ...sandbox.options,
      listRepositories: async () => [
        { ...repository("octo", "empty"), defaultBranchRef: null },
        repository("octo", "ready"),
      ],
    });

    expect(refreshed.repos.map((entry) => entry.nameWithOwner)).toEqual(["octo/ready"]);
    await expect(readRepositoryIndex(sandbox.options)).resolves.toEqual(refreshed);
  });

  it("still rejects malformed repository entries whose default branch field is omitted", async () => {
    const sandbox = await createSandbox();
    const malformed = repository("octo", "malformed");
    delete malformed.defaultBranchRef;

    await expect(refreshRepositoryIndex(["octo"], {
      ...sandbox.options,
      listRepositories: async () => [malformed],
    })).rejects.toThrow("has no default branch");
  });

  it("identifies stale caches and enabled sources predictably", () => {
    const index = { version: 1 as const, refreshedAt: "2026-07-29T12:00:00.000Z", repos: [] };
    expect(isIndexStale(index, 24, Date.parse("2026-07-30T12:00:00.000Z"))).toBe(true);
    expect(isIndexStale(index, 25, Date.parse("2026-07-30T12:00:00.000Z"))).toBe(false);
    expect(enabledSourceOwners({ octo: true, acme: false, beta: true })).toEqual(["beta", "octo"]);
  });
});

function repository(owner: string, name: string): Record<string, unknown> {
  return {
    nameWithOwner: `${owner}/${name}`,
    name,
    owner: { id: "owner-id", login: owner },
    defaultBranchRef: { name: "main" },
    description: "A test repository",
    isArchived: false,
  };
}

function storedRepository(owner: string, name: string): Record<string, unknown> {
  return {
    nameWithOwner: `${owner}/${name}`,
    name,
    owner,
    defaultBranch: "main",
    description: "A test repository",
  };
}

async function createSandbox(): Promise<{ options: { homeDirectory: string; agentDirectory: string } }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-flash-index-"));
  directories.push(directory);
  const homeDirectory = join(directory, "home");
  const agentDirectory = join(homeDirectory, ".pi", "agent");
  await mkdir(agentDirectory, { recursive: true });
  return { options: { homeDirectory, agentDirectory } };
}
