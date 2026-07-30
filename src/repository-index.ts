import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { scheduleRepositoryRefresh } from "./background.js";
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
    // Persist and spawn before returning the stale cache. The detached worker
    // survives a confident `/flash` launch replacing this Pi process.
    await scheduleRepositoryRefresh().catch(() => undefined);
  }
  return filterRepositoryIndexBySources(existing, config.sources);
}

/**
 * Treat the configured source list as the authorization boundary even when a
 * stale cache is all that is available. Disabling an owner takes effect
 * immediately and never depends on a successful network refresh.
 */
export function filterRepositoryIndexBySources(
  index: RepositoryIndex,
  sources: Readonly<Record<string, boolean>>,
): RepositoryIndex {
  const enabledOwners = new Set(enabledSourceOwners(sources));
  return {
    ...index,
    repos: index.repos.filter((repository) => enabledOwners.has(repository.owner)),
  };
}

/** Refreshes on user request, returning failure to the caller for clear UI. */
export async function refreshConfiguredSources(config: Config): Promise<RepositoryIndex> {
  const owners = enabledSourceOwners(config.sources);
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
