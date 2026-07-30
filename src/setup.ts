import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";

import { ConfigError, createDefaultConfig, readConfig, validateWorkspaceRoot, writeConfig, type Config } from "./config.js";
import { discoverGitHubIdentity } from "./github.js";
import { requireCommand } from "./process.js";

export interface SetupResult {
  config: Config;
  createdWorkspaceRoot: boolean;
}

/**
 * Performs the interactive first-run/configuration flow. It deliberately keeps
 * GitHub discovery and filesystem writes on opposite sides of the final
 * confirmation, so escaping any prompt leaves durable state untouched.
 */
export async function runSetup(ctx: ExtensionCommandContext): Promise<SetupResult | undefined> {
  ensureInteractive(ctx);
  ctx.ui.setWorkingMessage("Checking Pi Flash prerequisites…");
  try {
    await Promise.all([requireCommand("git"), requireCommand("gh"), requireCommand("pi")]);
    const identity = await discoverGitHubIdentity();
    const existing = await readConfig();
    const owners = [identity.login, ...identity.organizations.filter((owner) => owner !== identity.login)].sort((left, right) => {
      if (left === identity.login) return -1;
      if (right === identity.login) return 1;
      return left.localeCompare(right);
    });
    const enabledOwners = await chooseSources(ctx, owners, identity.login, existing?.sources ?? {});
    if (!enabledOwners) return undefined;

    const config = existing ?? createDefaultConfig();
    const defaultRoot = config.workspaceRoot;
    const requestedRoot = await ctx.ui.input(
      `Pi Flash workspace root [${defaultRoot}]`,
      "Press Enter to use the path shown above",
    );
    if (requestedRoot === undefined) return undefined;

    const autoLaunchThreshold = await chooseMatchingScore(
      ctx,
      "Auto-launch confidence (0–1)",
      config.matching.autoLaunchThreshold,
    );
    if (autoLaunchThreshold === undefined) return undefined;
    const minimumLeadOverSecond = await chooseMatchingScore(
      ctx,
      "Minimum lead over second result (0–1)",
      config.matching.minimumLeadOverSecond,
    );
    if (minimumLeadOverSecond === undefined) return undefined;

    const root = await chooseWorkspaceRoot(ctx, requestedRoot.trim() === "" ? defaultRoot : requestedRoot);
    if (!root) return undefined;

    config.workspaceRoot = root.path;
    config.sources = Object.fromEntries(owners.map((owner) => [owner, enabledOwners.has(owner)]));
    config.matching.autoLaunchThreshold = autoLaunchThreshold;
    config.matching.minimumLeadOverSecond = minimumLeadOverSecond;
    const saved = await writeConfig(config, { createWorkspaceRoot: root.created });
    ctx.ui.notify(
      `Pi Flash is ready. ${[...enabledOwners].length} source${enabledOwners.size === 1 ? "" : "s"} enabled; worktrees will live under ${saved.workspaceRoot}.`,
      "info",
    );
    return { config: saved, createdWorkspaceRoot: root.created };
  } finally {
    ctx.ui.setWorkingMessage();
  }
}

/** Shows a non-mutating diagnostic summary for fast troubleshooting. */
export async function runDoctor(ctx: ExtensionCommandContext): Promise<void> {
  ensureInteractive(ctx);
  const checks = await Promise.allSettled([requireCommand("git"), requireCommand("gh"), requireCommand("pi"), discoverGitHubIdentity(), readConfig()]);
  const labels = ["git", "gh", "pi", "GitHub authentication", "Pi Flash configuration"];
  const report = checks.map((check, index) => {
    if (check.status === "fulfilled") {
      if (index === 4 && check.value === undefined) return `✗ ${labels[index]}: run /flash setup`;
      return `✓ ${labels[index]}`;
    }
    const detail = check.reason instanceof Error ? check.reason.message : String(check.reason);
    return `✗ ${labels[index]}: ${detail}`;
  });
  const healthy = checks.every((check, index) => check.status === "fulfilled" && (index !== 4 || check.value !== undefined));
  ctx.ui.notify(report.join("\n"), healthy ? "info" : "warning");
}

function ensureInteractive(ctx: ExtensionCommandContext): void {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    throw new Error("Pi Flash setup requires an interactive Pi session");
  }
}

async function chooseSources(
  ctx: ExtensionCommandContext,
  owners: string[],
  activeLogin: string,
  configuredSources: Record<string, boolean>,
): Promise<Set<string> | undefined> {
  const selected = new Set(owners.filter((owner) => configuredSources[owner] ?? owner === activeLogin));
  const choice = await ctx.ui.custom<"continue" | "cancel">((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold("Welcome to Pi Flash")), 1, 1));
    container.addChild(new Text("Choose the GitHub accounts whose repositories Pi Flash should index. You can change this later with /flash config.", 1, 0));
    const items: SettingItem[] = [
      ...owners.map((owner) => ({
        id: `owner:${owner}`,
        label: owner === activeLogin ? `${owner} (you)` : owner,
        description: "Include this account in the local repository index",
        currentValue: selected.has(owner) ? "enabled" : "disabled",
        values: ["enabled", "disabled"],
      })),
      {
        id: "continue",
        label: "Continue",
        description: "Choose the local workspace root next",
        currentValue: "continue",
        values: ["continue"],
      },
    ];
    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, value) => {
        if (id === "continue") {
          done("continue");
          return;
        }
        const owner = id.slice("owner:".length);
        if (value === "enabled") selected.add(owner);
        else selected.delete(owner);
        list.updateValue(id, value);
        tui.requestRender();
      },
      () => done("cancel"),
      { enableSearch: true },
    );
    container.addChild(list);
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: { anchor: "center", width: 70, maxHeight: 24 } });
  return choice === "continue" ? selected : undefined;
}

async function chooseWorkspaceRoot(
  ctx: ExtensionCommandContext,
  requestedRoot: string,
): Promise<{ path: string; created: boolean } | undefined> {
  try {
    return { path: await validateWorkspaceRoot(requestedRoot), created: false };
  } catch (error) {
    if (!(error instanceof ConfigError) || error.code !== "workspace-root-missing") throw error;
    const create = await ctx.ui.confirm(
      "Create workspace root?",
      `${requestedRoot} does not exist. Create it now?`,
    );
    if (!create) return undefined;
    return { path: await validateWorkspaceRoot(requestedRoot, { createIfMissing: true }), created: true };
  }
}

async function chooseMatchingScore(
  ctx: ExtensionCommandContext,
  title: string,
  currentValue: number,
): Promise<number | undefined> {
  while (true) {
    const input = await ctx.ui.input(
      `${title} [${currentValue}]`,
      "Press Enter to keep the value shown above",
    );
    if (input === undefined) return undefined;
    if (input.trim() === "") return currentValue;

    const value = Number(input);
    if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
    ctx.ui.notify("Enter a number from 0 to 1, or press Enter to keep the current value.", "warning");
  }
}
