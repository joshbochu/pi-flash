import { describe, expect, it } from "vitest";

import type { RepositoryIndex } from "../src/index-store.js";
import { filterRepositoryIndexBySources } from "../src/repository-index.js";

describe("configured repository sources", () => {
  it("removes disabled and unknown owners from a cached index immediately", () => {
    const index: RepositoryIndex = {
      version: 1,
      refreshedAt: "2026-07-30T12:00:00.000Z",
      repos: [
        repository("acme", "billing"),
        repository("octo", "flash"),
        repository("former-org", "legacy"),
      ],
    };

    expect(filterRepositoryIndexBySources(index, {
      acme: false,
      octo: true,
    })).toEqual({
      ...index,
      repos: [repository("octo", "flash")],
    });
    expect(index.repos).toHaveLength(3);
  });
});

function repository(owner: string, name: string) {
  return {
    nameWithOwner: `${owner}/${name}`,
    owner,
    name,
    defaultBranch: "main",
    description: "",
  };
}
