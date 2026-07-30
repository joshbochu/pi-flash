import type { MatchingConfig } from "./config.js";
import type { RepositoryIndexEntry } from "./index-store.js";

export interface RepositoryMatch {
  repository: RepositoryIndexEntry;
  score: number;
}

export type MatchDecision =
  | { kind: "auto"; match: RepositoryMatch; reason: "exact-canonical" | "confident"; ranked: RepositoryMatch[] }
  | { kind: "pick"; ranked: RepositoryMatch[] }
  | { kind: "none"; ranked: [] };

/**
 * Ranks names only for bare queries and canonical owner/name only for queries
 * containing a slash. Descriptions are deliberately never part of this score.
 */
export function rankRepositories(query: string, repositories: readonly RepositoryIndexEntry[]): RepositoryMatch[] {
  const normalizedQuery = normalize(query);
  const canonicalQuery = normalizedQuery.includes("/");
  const matches = repositories.map((repository) => ({
    repository,
    score: score(normalizedQuery, normalize(canonicalQuery ? repository.nameWithOwner : repository.name)),
  }));

  return matches
    .filter((match) => normalizedQuery === "" || match.score > 0)
    .sort((left, right) => right.score - left.score || left.repository.nameWithOwner.localeCompare(right.repository.nameWithOwner));
}

export function decideRepositoryMatch(
  query: string,
  repositories: readonly RepositoryIndexEntry[],
  matching: MatchingConfig,
): MatchDecision {
  const normalizedQuery = normalize(query);
  const ranked = rankRepositories(normalizedQuery, repositories);
  const top = ranked[0];
  if (!top) return { kind: "none", ranked: [] };
  if (normalizedQuery.includes("/") && normalize(top.repository.nameWithOwner) === normalizedQuery) {
    return { kind: "auto", match: top, reason: "exact-canonical", ranked };
  }
  if (normalizedQuery === "") return { kind: "pick", ranked };

  const secondScore = ranked[1]?.score ?? 0;
  if (top.score >= matching.autoLaunchThreshold && top.score - secondScore >= matching.minimumLeadOverSecond) {
    return { kind: "auto", match: top, reason: "confident", ranked };
  }
  return { kind: "pick", ranked: ranked.slice(0, matching.resultsShownWhenAmbiguous) };
}

function score(query: string, candidate: string): number {
  if (query === "") return 0;
  if (query === candidate) return 1;
  if (candidate.startsWith(query)) {
    return clamp(0.96 - Math.min(0.16, (candidate.length - query.length) * 0.012));
  }
  const substringAt = candidate.indexOf(query);
  if (substringAt >= 0) {
    return clamp(0.88 - Math.min(0.18, substringAt * 0.025 + (candidate.length - query.length) * 0.006));
  }

  let cursor = 0;
  let first = -1;
  let last = -1;
  let gaps = 0;
  for (const character of query) {
    const found = candidate.indexOf(character, cursor);
    if (found < 0) return 0;
    if (first < 0) first = found;
    if (last >= 0) gaps += found - last - 1;
    last = found;
    cursor = found + 1;
  }
  const span = last - first + 1;
  const density = query.length / span;
  const coverage = query.length / candidate.length;
  const early = 1 - first / Math.max(1, candidate.length);
  return clamp(0.38 + density * 0.31 + coverage * 0.22 + early * 0.09 - Math.min(0.1, gaps * 0.015));
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
