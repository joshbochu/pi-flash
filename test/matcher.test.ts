import { describe, expect, it } from "vitest";

import { decideRepositoryMatch, rankRepositories } from "../src/matcher.js";

const matching = {
  autoLaunchThreshold: 0.82,
  minimumLeadOverSecond: 0.08,
  resultsShownWhenAmbiguous: 8,
};

const repositories = [
  repository("acme", "billing", "Invoice service"),
  repository("other", "billing", "A similarly named repository"),
  repository("acme", "billing-api", "API"),
  repository("acme", "flash", "Description must not affect matching"),
];

describe("repository matching", () => {
  it("scores a bare query against repository names, never descriptions", () => {
    const ranked = rankRepositories("billing", repositories);
    expect(ranked.slice(0, 3).map((match) => match.repository.nameWithOwner)).toEqual([
      "acme/billing",
      "other/billing",
      "acme/billing-api",
    ]);
    expect(rankRepositories("description", repositories)).toEqual([]);
  });

  it("scores slash queries against canonical owner/repository names", () => {
    const ranked = rankRepositories("acme/bill", repositories);
    expect(ranked[0]?.repository.nameWithOwner).toBe("acme/billing");
    expect(ranked.every((match) => match.repository.nameWithOwner.startsWith("acme/"))).toBe(true);
  });

  it("always auto-launches an exact canonical match", () => {
    const decision = decideRepositoryMatch("AcMe/BiLlInG", repositories, matching);
    expect(decision).toMatchObject({ kind: "auto", reason: "exact-canonical", match: { repository: { nameWithOwner: "acme/billing" } } });
  });

  it("does not auto-launch duplicate bare names regardless of score", () => {
    const decision = decideRepositoryMatch("billing", repositories, matching);
    expect(decision.kind).toBe("pick");
    if (decision.kind === "pick") {
      expect(decision.ranked.slice(0, 2).map((match) => match.repository.nameWithOwner)).toEqual(["acme/billing", "other/billing"]);
    }
  });

  it("auto-launches a clear confident result and sends uncertain results to the picker", () => {
    const clear = decideRepositoryMatch("flas", repositories, matching);
    expect(clear).toMatchObject({ kind: "auto", reason: "confident", match: { repository: { nameWithOwner: "acme/flash" } } });

    const uncertain = decideRepositoryMatch("bill", repositories, { ...matching, autoLaunchThreshold: 0.99 });
    expect(uncertain.kind).toBe("pick");
  });

  it("opens a picker for an empty query and reports no candidates without a network refresh", () => {
    expect(decideRepositoryMatch("", repositories, matching)).toMatchObject({ kind: "pick" });
    expect(decideRepositoryMatch("definitely-not-here", repositories, matching)).toEqual({ kind: "none", ranked: [] });
  });
});

function repository(owner: string, name: string, description: string) {
  return { nameWithOwner: `${owner}/${name}`, owner, name, defaultBranch: "main", description };
}
