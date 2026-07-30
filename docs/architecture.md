# Pi Flash architecture

Pi Flash is a global Pi extension that opens a fresh, isolated Pi session in a
Git worktree selected from a local GitHub repository index.

## Runtime boundaries

```text
Pi extension command
  -> configuration + durable state
  -> repository index + matcher
  -> Git workspace service
  -> replacement-process handoff
```

The extension is TypeScript. Git and GitHub operations remain delegated to the
user's `git` and `gh` executables; their process and network costs dwarf the
small local scoring and JSON work done by the extension.

## State layout

```text
<pi-agent-dir>/pi-flash/config.json
<pi-agent-dir>/pi-flash/index.json
<pi-agent-dir>/pi-flash/registry.json
<pi-agent-dir>/pi-flash/history.jsonl

<workspace-root>/.flash/repos/<owner>/<repository>.git
<workspace-root>/worktrees/<owner>/<repository>/<petname>
```

`<pi-agent-dir>` follows `PI_CODING_AGENT_DIR` and defaults to
`~/.pi/agent`. All persistent files are versioned, written atomically with
owner-only permissions, and guarded by a cross-process lock. The registry is
the authority for managed worktrees; history is append-only audit and recovery
data.

## Launch lifecycle

1. Load configuration and ensure Pi Flash has completed setup.
2. Read the local repository index. A stale populated index starts a background
   refresh; it never delays repository matching. A no-match view offers explicit
   refresh rather than starting an unexpected network operation.
3. Select a repository from an exact match, confident fuzzy match, or picker.
4. Acquire a repository lock. Pi Flash supports GitHub.com in the initial
   release and rejects a different active `gh` host during setup.
5. Ensure the owner/repository-namespaced bare clone exists and matches its
   expected remote.
6. Fetch the bare clone. On failure after configured retries, use a verified
   cached base ref and record its staleness.
7. Create a unique branch and worktree from the remote default branch.
8. Record the worktree in the registry and history.
9. Start the replacement Pi process in the worktree and shut down the parent.

Any failure before handoff leaves the initiating Pi usable. A worktree created
before a failed handoff remains registered and is surfaced in history so it can
be recovered deliberately.

## Cleanup lifecycle

Cleanup is planned before it is executed. Its default mode is report-only.

1. Scan registry entries when Pi Flash is used.
2. Skip active, locked, unsafe, or recently used worktrees.
3. For an eligible worktree, inspect Git status and untracked files.
4. Default policy blocks every untracked file, including ignored files. Ignored
   files are never staged automatically.
5. Park eligible changes with a commit and a non-destructive push.
6. Verify the remote contains the parked commit.
7. Remove the local worktree only after verification succeeds.
8. Append the outcome to history and update the registry.

Parking operations persist an operation ID and advance through `planned`,
`committed`, `pushed`, `remote-verified`, `removed`, and `recorded` states.
Startup and cleanup scans reconcile incomplete operations conservatively.

## Security invariants

- Every external process uses an argument array, never shell interpolation.
- Owner, repository, petname, branch namespace, and workspace paths are
  validated before use.
- Destructive targets must resolve beneath the configured workspace root.
- Existing bare clones are checked against the canonical remote before reuse.
- Failure records contain metadata, never command output that might contain
  credentials.
- Mutating operations are available only through user-invoked commands.
