import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { readConfig } from "./config.js";
import { runDoctor, runSetup } from "./setup.js";

const help = [
  "Pi Flash launches a fresh Pi session in an isolated Git worktree.",
  "Usage: /flash [repository query]",
  "Commands: /flash setup, /flash config, /flash doctor, /flash help",
  "Repository launching and index refresh will be available after setup.",
].join("\n");

export default function piFlash(pi: ExtensionAPI): void {
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
          await runSetup(ctx);
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
            ctx.ui.notify("Setup is complete. Run /flash again to choose a repository.", "info");
          }
          return;
        }
        ctx.ui.notify(`Repository matching for ${query} arrives in the next Pi Flash milestone.`, "info");
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
