import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/config.js";
import { GitWorkspaceError, getBareRepositoryPath, prepareWorkspace } from "../src/git-workspace.js";
import { runCommand } from "../src/process.js";

const directories: string[] = [];

describe("Git worktree preparation", () => {
  it("shares one partial bare clone while making a unique branch and worktree for every launch", async () => {
    const sandbox = await createRepositorySandbox();
    const config = createWorkspaceConfig(sandbox.workspaceRoot);
    const repository = indexedRepository();

    const first = await prepareWorkspace(repository, config, "josh", {
      remoteUrl: sandbox.remoteUrl,
      createPetName: () => "brisk-otter-000001",
      now: () => new Date("2026-07-30T10:00:00.000Z"),
    });
    expect(first).toMatchObject({ stale: false, attempts: 0, branch: "josh/brisk-otter-000001" });
    expect(first.barePath).toBe(getBareRepositoryPath(sandbox.workspaceRoot, repository));
    expect(await readFile(join(first.worktreePath, "README.md"), "utf8")).toBe("first\n");

    await commitAndPush(sandbox.sourcePath, "README.md", "second\n", "second");
    const second = await prepareWorkspace(repository, config, "josh", {
      remoteUrl: sandbox.remoteUrl,
      createPetName: () => "calm-wren-000002",
      now: () => new Date("2026-07-30T10:01:00.000Z"),
    });
    expect(second).toMatchObject({ stale: false, attempts: 1, branch: "josh/calm-wren-000002" });
    expect(second.barePath).toBe(first.barePath);
    expect(second.worktreePath).not.toBe(first.worktreePath);
    expect(second.baseSha).not.toBe(first.baseSha);
    expect(await readFile(join(second.worktreePath, "README.md"), "utf8")).toBe("second\n");
  });

  it("retries a failed fetch and launches from a verified cached default branch", async () => {
    const sandbox = await createRepositorySandbox();
    const config = createWorkspaceConfig(sandbox.workspaceRoot);
    const repository = indexedRepository();
    const fresh = await prepareWorkspace(repository, config, "josh", {
      remoteUrl: sandbox.remoteUrl,
      createPetName: () => "brisk-otter-000001",
    });
    await rm(sandbox.originPath, { recursive: true, force: true });
    const delays: number[] = [];

    const stale = await prepareWorkspace(repository, config, "josh", {
      remoteUrl: sandbox.remoteUrl,
      createPetName: () => "calm-wren-000002",
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });
    expect(stale).toMatchObject({ stale: true, attempts: 3, baseSha: fresh.baseSha });
    expect(delays).toEqual([500, 1000]);
    expect(await readFile(join(stale.worktreePath, "README.md"), "utf8")).toBe("first\n");
  });

  it("refuses an origin mismatch without changing the existing bare repository", async () => {
    const sandbox = await createRepositorySandbox();
    const config = createWorkspaceConfig(sandbox.workspaceRoot);
    const repository = indexedRepository();
    const first = await prepareWorkspace(repository, config, "josh", {
      remoteUrl: sandbox.remoteUrl,
      createPetName: () => "brisk-otter-000001",
    });
    await command("git", ["-C", first.barePath, "remote", "set-url", "origin", "file:///different/repository.git"]);

    await expect(prepareWorkspace(repository, config, "josh", {
      remoteUrl: sandbox.remoteUrl,
      createPetName: () => "calm-wren-000002",
    })).rejects.toThrow(GitWorkspaceError);
    expect(await readFile(join(first.worktreePath, "README.md"), "utf8")).toBe("first\n");
  });

  it("does not create a stale worktree when the cached default ref is absent", async () => {
    const sandbox = await createRepositorySandbox();
    const config = createWorkspaceConfig(sandbox.workspaceRoot);
    const repository = indexedRepository();
    const barePath = getBareRepositoryPath(sandbox.workspaceRoot, repository);
    await mkdir(join(sandbox.workspaceRoot, ".flash", "repos", repository.owner), { recursive: true });
    await command("git", ["init", "--bare", barePath]);
    await command("git", ["-C", barePath, "remote", "add", "origin", sandbox.remoteUrl]);
    await rm(sandbox.originPath, { recursive: true, force: true });

    await expect(prepareWorkspace(repository, config, "josh", {
      remoteUrl: sandbox.remoteUrl,
      createPetName: () => "brisk-otter-000001",
      sleep: async () => undefined,
    })).rejects.toThrow("no verified cached commit");
  });
});

function indexedRepository() {
  return { nameWithOwner: "acme/billing", owner: "acme", name: "billing", defaultBranch: "main", description: "" };
}

function createWorkspaceConfig(workspaceRoot: string) {
  const config = createDefaultConfig({ homeDirectory: workspaceRoot });
  config.workspaceRoot = workspaceRoot;
  return config;
}

async function createRepositorySandbox(): Promise<{ originPath: string; sourcePath: string; workspaceRoot: string; remoteUrl: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-flash-git-"));
  directories.push(root);
  const originPath = join(root, "origin.git");
  const sourcePath = join(root, "source");
  const workspaceRoot = join(root, "workspace");
  await mkdir(sourcePath, { recursive: true });
  await command("git", ["init", "--bare", originPath]);
  await command("git", ["init", sourcePath]);
  await command("git", ["-C", sourcePath, "config", "user.name", "Pi Flash tests"]);
  await command("git", ["-C", sourcePath, "config", "user.email", "tests@example.invalid"]);
  await writeFile(join(sourcePath, "README.md"), "first\n");
  await command("git", ["-C", sourcePath, "add", "README.md"]);
  await command("git", ["-C", sourcePath, "commit", "-m", "first"]);
  await command("git", ["-C", sourcePath, "branch", "-M", "main"]);
  await command("git", ["-C", sourcePath, "remote", "add", "origin", `file://${originPath}`]);
  await command("git", ["-C", sourcePath, "push", "-u", "origin", "main"]);
  return { originPath, sourcePath, workspaceRoot, remoteUrl: `file://${originPath}` };
}

async function commitAndPush(sourcePath: string, file: string, content: string, message: string): Promise<void> {
  await writeFile(join(sourcePath, file), content);
  await command("git", ["-C", sourcePath, "add", file]);
  await command("git", ["-C", sourcePath, "commit", "-m", message]);
  await command("git", ["-C", sourcePath, "push", "origin", "main"]);
}

async function command(commandName: string, args: string[]): Promise<void> {
  const result = await runCommand(commandName, args, { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`${commandName} ${args.join(" ")} failed: ${result.stderr}`);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
