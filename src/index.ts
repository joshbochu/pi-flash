import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { readConfig } from "./config.js";
import { HandoffController } from "./handoff.js";
import { launchRepository } from "./launch.js";
import { decideRepositoryMatch } from "./matcher.js";
import { pickRepository } from "./picker.js";
import { ensureRepositoryIndex, refreshWithProgress } from "./repository-index.js";
import { runDoctor, runSetup } from "./setup.js";

const help = [
  "Pi Flash launches a fresh Pi session in an isolated Git worktree.",
  "Usage: /flash [repository query]",
  "Commands: /flash setup, /flash config, /flash refresh, /flash doctor, /flash help",
  "A confident query launches immediately; other queries open the picker.",
].join("\n");

export default function piFlash(pi: ExtensionAPI): void {
  const handoff = new HandoffController();
  pi.on("session_shutdown", async () => {
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
        if (query === "refresh") {
          await refreshWithProgress(ctx, config);
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

function reportError(ctx: ExtensionCommandContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`Pi Flash: ${message}`, "error");
}
