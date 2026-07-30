import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { Config } from "./config.js";
import { prepareWorkspace, type WorkspacePreparation } from "./git-workspace.js";
import { getGitHubLogin } from "./github.js";
import { HandoffController } from "./handoff.js";
import { recordCreatedWorktree, appendHistory } from "./history.js";
import type { RepositoryIndexEntry } from "./index-store.js";
import { registerWorktree } from "./registry.js";

/**
 * Does all network/Git work before scheduling the single process handoff. A
 * failure leaves the initiating Pi untouched; a successful schedule uses
 * Pi's graceful shutdown to release the terminal for the replacement.
 */
export async function launchRepository(
  ctx: ExtensionCommandContext,
  controller: HandoffController,
  config: Config,
  repository: RepositoryIndexEntry,
): Promise<WorkspacePreparation> {
  if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("Pi Flash launches worktrees only from an interactive Pi session");
  if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for Pi to become idle before launching a fresh worktree");

  const login = config.branchNamespace ?? await getGitHubLogin();
  let workspace: WorkspacePreparation | undefined;
  ctx.ui.setWorkingMessage(`Preparing ${repository.nameWithOwner}…`);
  try {
    // Preflight before creating the worktree so an unavailable launcher cannot
    // strand a newly created directory.
    const request = controller.preflight(config.workspaceRoot);
    workspace = await prepareWorkspace(repository, config, login);
    request.targetCwd = workspace.worktreePath;
    const record = await registerWorktree(repository, workspace);
    await recordCreatedWorktree(record, repository, workspace);
    controller.schedule(request);
    await appendHistory({
      version: 1,
      at: new Date().toISOString(),
      event: "handoff-scheduled",
      metadata: { id: record.id, repo: repository.nameWithOwner, branch: workspace.branch, path: workspace.worktreePath },
    });
    if (workspace.stale) {
      ctx.ui.notify(
        `Git fetch failed after ${workspace.attempts} attempts. Launching cached ${workspace.baseSha.slice(0, 12)} from ${workspace.lastFetchedAt}.`,
        "warning",
      );
    } else {
      ctx.ui.notify(`Launching ${repository.nameWithOwner} in ${workspace.worktreePath}.`, "info");
    }
    ctx.shutdown();
    return workspace;
  } catch (error) {
    controller.cancel();
    if (workspace) {
      throw new Error(
        `Pi Flash could not complete the handoff. The isolated worktree was kept at ${workspace.worktreePath}.`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
    throw error;
  } finally {
    ctx.ui.setWorkingMessage();
  }
}
