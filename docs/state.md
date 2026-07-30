# Persistent-state schemas

All schemas include a `version` field. Unknown future versions fail closed with
an actionable migration error; absent values are filled from documented defaults.

## Configuration

```json
{
  "version": 1,
  "host": "github.com",
  "workspaceRoot": "/absolute/path/to/dev",
  "sources": {
    "joshbochu": true,
    "example-org": false
  },
  "branchNamespace": null,
  "matching": {
    "autoLaunchThreshold": 0.82,
    "minimumLeadOverSecond": 0.08,
    "resultsShownWhenAmbiguous": 8
  },
  "index": { "maxAgeHours": 24 },
  "fetch": {
    "attempts": 3,
    "timeoutSeconds": 30,
    "initialBackoffMilliseconds": 500
  },
  "cleanup": {
    "enabled": false,
    "inactiveAfterDays": 14,
    "untrackedFiles": "block",
    "ignoredFiles": "block"
  }
}
```

`branchNamespace: null` means the active GitHub login. `untrackedFiles` is
either `block` or `include-unignored`; `ignoredFiles` is `block` or
`discard`. Both values default to `block`. New workspace roots are canonicalized
before storage and must not resolve to the filesystem root, the home directory,
or the Pi agent directory.

## Repository index

```json
{
  "version": 1,
  "refreshedAt": "2026-07-30T18:19:01Z",
  "repos": [
    {
      "nameWithOwner": "owner/repository",
      "defaultBranch": "main",
      "description": ""
    }
  ]
}
```

## Registry

```json
{
  "version": 1,
  "worktrees": [
    {
      "id": "uuid",
      "repo": "owner/repository",
      "path": "/absolute/path",
      "branch": "namespace/petname",
      "base": { "sha": "...", "stale": false, "fetchedAt": "..." },
      "createdAt": "...",
      "lastUsedAt": "...",
      "activeLease": { "pid": 12345, "heartbeatAt": "..." },
      "status": "active"
    }
  ],
  "operations": []
}
```

An active lease records the Pi process that has opened a managed worktree and
its latest heartbeat. A non-null lease blocks cleanup. The workspace root is
stored as a canonical absolute path even when setup input used `~`.

Cleanup records a durable operation state (`planned`, `committed`, `pushed`,
`remote-verified`, `removed`, or `recorded`) so interrupted remote pushes and
local removals can be reconciled without guessing.

## History

History is JSONL. Each line has `version`, `at`, `event`, and a serializable
metadata object. It records worktree creation, handoff scheduling, stale
fallback, cleanup parking/removal, skips, and failures. It is an audit trail,
not the source of truth for active worktrees.
