import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { Config } from "./config.js";
import {
  enabledSourceOwners,
  getIndexPath,
  isIndexStale,
  readRepositoryIndex,
  refreshRepositoryIndex,
  type RepositoryIndex,
} from "./index-store.js";

const activeRefreshes = new Map<string, Promise<RepositoryIndex>>();

/**
 * Ensures a first index exists. Existing stale data is returned immediately
 * while a deduplicated refresh continues in the background, keeping normal
 * `/flash` matching out of the network critical path.
 */
export async function ensureRepositoryIndex(config: Config): Promise<RepositoryIndex> {
  const existing = await readRepositoryIndex();
  if (!existing) return refreshConfiguredSources(config);
  if (isIndexStale(existing, config.index.maxAgeHours)) {
    void refreshConfiguredSources(config).catch(() => undefined);
  }
  return existing;
}

/** Refreshes on user request, returning failure to the caller for clear UI. */
export async function refreshConfiguredSources(config: Config): Promise<RepositoryIndex> {
  const owners = enabledSourceOwners(config.sources);
  if (owners.length === 0) {
    throw new Error("No GitHub accounts are enabled. Run /flash config to enable at least one repository source.");
  }
  const key = getIndexPath();
  const current = activeRefreshes.get(key);
  if (current) return current;

  const refresh = refreshRepositoryIndex(owners).finally(() => activeRefreshes.delete(key));
  activeRefreshes.set(key, refresh);
  return refresh;
}

export async function refreshWithProgress(ctx: ExtensionCommandContext, config: Config): Promise<RepositoryIndex> {
  ctx.ui.setWorkingMessage("Refreshing GitHub repository index…");
  try {
    const index = await refreshConfiguredSources(config);
    const noun = index.repos.length === 1 ? "repository" : "repositories";
    ctx.ui.notify(`Indexed ${index.repos.length} ${noun}.`, "info");
    return index;
  } finally {
    ctx.ui.setWorkingMessage();
  }
}
