import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { readConfig, writeConfig, type Config } from "./config.js";
import { cleanEligibleWorktree, scanCleanup } from "./cleanup.js";
import { HandoffController } from "./handoff.js";
import { readHistory } from "./history.js";
import { launchRepository } from "./launch.js";
import { decideRepositoryMatch } from "./matcher.js";
import { pickRepository } from "./picker.js";
import { ensureRepositoryIndex, refreshWithProgress } from "./repository-index.js";
import { clearWorktreeLeaseForPath, setWorktreeLeaseForPath } from "./registry.js";
import { runDoctor, runSetup } from "./setup.js";

const help = [
  "Pi Flash launches a fresh Pi session in an isolated Git worktree.",
  "Usage: /flash [repository query]",
  "Commands: /flash setup, /flash config, /flash refresh, /flash history, /flash doctor, /flash help",
  "A confident query launches immediately; other queries open the picker.",
].join("\n");

export default function piFlash(pi: ExtensionAPI): void {
  const handoff = new HandoffController();
  pi.on("session_start", async (_event, ctx) => {
    await setWorktreeLeaseForPath(ctx.cwd, process.pid).catch(() => undefined);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await clearWorktreeLeaseForPath(ctx.cwd, process.pid).catch(() => undefined);
    handoff.spawnPending();
  });
  pi.registerCommand("flash", {
    description: "Launch a fresh Pi session in an isolated Git worktree",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        throw new Error("Pi Flash requires an interactive Pi session");
      }
      const query = args.trim();
      if (query === "help" || query === "--help" || query === "-h") {
        ctx.ui.notify(help, "info");
        return;
      }
      try {
        if (query === "setup" || query === "config") {
          const setup = await runSetup(ctx);
          if (setup) await refreshWithProgress(ctx, setup.config);
          return;
        }
        if (query === "doctor") {
          await runDoctor(ctx);
          return;
        }
        const config = await readConfig();
        if (!config) {
          const setup = await runSetup(ctx);
          if (setup) {
            await refreshWithProgress(ctx, setup.config);
            ctx.ui.notify("Setup is complete. Run /flash again to choose a repository.", "info");
          }
          return;
        }
        scheduleAutomaticCleanup(config);
        if (query === "refresh") {
          await refreshWithProgress(ctx, config);
          return;
        }
        if (query.startsWith("clean")) {
          await runCleanupCommand(ctx, query, config);
          return;
        }
        if (query === "history") {
          const history = await readHistory();
          if (history.length === 0) {
            ctx.ui.notify("Pi Flash history is empty.", "info");
            return;
          }
          const recent = history.slice(-12).reverse().map((entry) => {
            const repo = typeof entry.metadata.repo === "string" ? ` ${entry.metadata.repo}` : "";
            const branch = typeof entry.metadata.branch === "string" ? ` (${entry.metadata.branch})` : "";
            return `${entry.at}  ${entry.event}${repo}${branch}`;
          });
          ctx.ui.notify(recent.join("\n"), "info");
          return;
        }
        const index = await ensureRepositoryIndex(config);
        const decision = decideRepositoryMatch(query, index.repos, config.matching);
        if (decision.kind === "none") {
          ctx.ui.notify(`No indexed repository matches ${JSON.stringify(query)}. Run /flash refresh to update the cache.`, "warning");
          return;
        }
        if (decision.kind === "auto") {
          await launchRepository(ctx, handoff, config, decision.match.repository);
          return;
        }
        const repository = await pickRepository(ctx, decision.ranked.map((match) => match.repository), query);
        if (repository) {
          await launchRepository(ctx, handoff, config, repository);
        }
      } catch (error) {
        reportError(ctx, error);
      }
    },
  });
}

function scheduleAutomaticCleanup(config: Config): void {
  if (!config.cleanup.enabled) return;
  void scanCleanup(config).then(async (proposals) => {
    for (const proposal of proposals) {
      if (proposal.eligible) await cleanEligibleWorktree(proposal.record, config).catch(() => undefined);
    }
  }).catch(() => undefined);
}

async function runCleanupCommand(ctx: ExtensionCommandContext, query: string, config: Config): Promise<void> {
  if (query === "clean enable" || query === "clean disable") {
    const enable = query === "clean enable";
    const confirmed = await ctx.ui.confirm("Pi Flash cleanup", enable ? "Enable automatic cleanup for eligible inactive worktrees? It will only park verified branches before removal." : "Disable automatic cleanup?");
    if (!confirmed) return;
    await writeConfig({ ...config, cleanup: { ...config.cleanup, enabled: enable } });
    ctx.ui.notify(enable ? "Automatic cleanup enabled. Run /flash clean to review candidates now." : "Automatic cleanup disabled; scans remain report-only.", "info");
    return;
  }
  if (query === "clean config") {
    const untracked = await ctx.ui.select("Untracked-file cleanup policy", ["block (safest)", "include non-ignored files"]);
    if (!untracked) return;
    const ignored = await ctx.ui.select("Ignored-file cleanup policy", ["block (safest)", "discard ignored files after remote verification"]);
    if (!ignored) return;
    await writeConfig({ ...config, cleanup: { ...config.cleanup, untrackedFiles: untracked.startsWith("block") ? "block" : "include-unignored", ignoredFiles: ignored.startsWith("block") ? "block" : "discard" } });
    ctx.ui.notify("Cleanup policy saved.", "info");
    return;
  }
  if (query !== "clean") { ctx.ui.notify("Use /flash clean, /flash clean enable, /flash clean disable, or /flash clean config.", "warning"); return; }
  const proposals = await scanCleanup(config);
  const eligible = proposals.filter((proposal) => proposal.eligible);
  const report = proposals.length === 0 ? "No Pi Flash worktrees are registered." : proposals.map((proposal) => `${proposal.eligible ? "ready" : "skip"}  ${proposal.record.repo} (${proposal.record.branch})${proposal.reasons.length ? `: ${proposal.reasons.join(", ")}` : ""}`).join("\n");
  ctx.ui.notify(report, "info");
  if (eligible.length === 0) return;
  const confirmed = await ctx.ui.confirm("Park and remove eligible worktrees?", `${eligible.length} eligible worktree${eligible.length === 1 ? "" : "s"} will be pushed, verified, and then removed locally.`);
  if (!confirmed) return;
  for (const proposal of eligible) {
    try { await cleanEligibleWorktree(proposal.record, config); ctx.ui.notify(`Removed ${proposal.record.repo} (${proposal.record.branch}).`, "info"); }
    catch (error) { ctx.ui.notify(`Kept ${proposal.record.repo}: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
  }
}

function reportError(ctx: ExtensionCommandContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`Pi Flash: ${message}`, "error");
}
