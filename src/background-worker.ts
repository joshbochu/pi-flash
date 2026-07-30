import { pathToFileURL } from "node:url";

import {
  runBackgroundWorker,
  type BackgroundJobResult,
  type BackgroundRequest,
} from "./background.js";
import { cleanEligibleWorktree, reconcileIncompleteCleanup, scanCleanup } from "./cleanup.js";
import { readConfig } from "./config.js";
import { appendHistory } from "./history.js";
import { refreshConfiguredSources } from "./repository-index.js";

export async function executeBackgroundJob(request: BackgroundRequest): Promise<BackgroundJobResult> {
  const config = await readConfig();
  if (!config) return { status: "skipped", summary: "Pi Flash is not configured." };

  if (request.kind === "refresh-index") {
    const index = await refreshConfiguredSources(config);
    const noun = index.repos.length === 1 ? "repository" : "repositories";
    return { status: "succeeded", summary: `Indexed ${index.repos.length} ${noun}.` };
  }

  if (!config.cleanup.enabled) {
    return { status: "skipped", summary: "Automatic cleanup is disabled." };
  }

  const reconciliation = await reconcileIncompleteCleanup(config);
  const proposals = await scanCleanup(config);
  for (const proposal of proposals) {
    await appendHistory({
      version: 1,
      at: new Date().toISOString(),
      event: "cleanup-proposed",
      metadata: {
        id: proposal.record.id,
        repo: proposal.record.repo,
        branch: proposal.record.branch,
        eligible: proposal.eligible,
        reason: proposal.reasons.join(","),
      },
    });
  }
  const eligible = proposals.filter((proposal) => proposal.eligible);
  let removed = 0;
  const failures: string[] = [...reconciliation.failures];
  for (const proposal of eligible) {
    try {
      await cleanEligibleWorktree(proposal.record, config);
      removed += 1;
    } catch (error: unknown) {
      failures.push(`${proposal.record.repo}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Removed ${removed} worktree${removed === 1 ? "" : "s"}; ${failures.length} failed. ${failures.join(" ")}`);
  }
  return {
    status: "succeeded",
    summary: `Reconciled ${reconciliation.reconciled} operation${reconciliation.reconciled === 1 ? "" : "s"}; scanned ${proposals.length} worktree${proposals.length === 1 ? "" : "s"}; removed ${removed}.`,
  };
}

export async function main(): Promise<void> {
  await runBackgroundWorker({ executeJob: executeBackgroundJob });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Pi Flash background worker failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
