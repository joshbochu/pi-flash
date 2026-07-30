import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const help = [
  "Pi Flash is installed but not configured yet.",
  "Run /flash setup to choose a workspace and repository sources.",
  "Run /flash help to view command guidance.",
].join("\n");

export default function piFlash(pi: ExtensionAPI): void {
  pi.registerCommand("flash", {
    description: "Launch a fresh Pi session in an isolated Git worktree",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        throw new Error("Pi Flash requires an interactive Pi session");
      }
      const query = args.trim();
      if (query === "" || query === "help" || query === "--help" || query === "-h") {
        ctx.ui.notify(help, "info");
        return;
      }
      ctx.ui.notify(`Pi Flash setup is required before launching ${query}. Run /flash setup.`, "warning");
    },
  });
}
