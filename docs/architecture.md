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
<pi-agent-dir>/pi-flash/background/requests/*.json
<pi-agent-dir>/pi-flash/background/events.jsonl

<workspace-root>/.flash/repos/<owner>/<repository>.git
<workspace-root>/.flash/locks/<repository-hash>.lock
<workspace-root>/worktrees/<owner>/<repository>/<petname>
```

`<pi-agent-dir>` follows `PI_CODING_AGENT_DIR` and defaults to
`~/.pi/agent`. Snapshot files are versioned and written atomically; append-only
logs use synced records. All state has owner-only permissions. The registry is
the authority for managed worktrees; history is append-only audit and recovery
data. Registry mutations and
repository preparation use interprocess locks so concurrent Pi sessions cannot
lose state or race the first clone.

## Launch lifecycle

1. Load configuration and ensure Pi Flash has completed setup.
2. Read the local repository index. Disabled owners are removed from cached
   results immediately. A stale populated index schedules a detached background
   refresh; it never delays repository matching. A no-match view offers explicit
   refresh rather than starting an unexpected foreground network operation.
3. Select a repository from an exact match, confident fuzzy match, or picker.
4. Pi Flash supports GitHub.com in the initial release and ensures the
   owner/repository-namespaced bare clone exists and matches its
   expected remote.
5. Fetch the bare clone on every launch. On failure after configured retries, use a verified
   cached base ref and record its staleness.
6. Create a unique branch and worktree from the remote default branch, allowing
   Git to parallelize checkout without changing the user's Git configuration.
7. Record the worktree in the registry and history.
8. Gracefully shut down Pi, then replace that same Node.js process with a blank
   Pi in the worktree; runtimes without `execve` retain the compatible child
   handoff.

Any failure before handoff leaves the initiating Pi usable. A worktree created
before a failed handoff remains registered and is surfaced in history so it can
be recovered deliberately.

## Cleanup lifecycle

Cleanup is planned before it is executed. Its default mode is report-only.

1. Reconcile any incomplete durable operation, then scan registry entries when
   Pi Flash is used.
2. Recover only leases whose process is conclusively dead or whose PID identity
   has been recycled.
3. Skip active, unsafe, or recently used worktrees.
4. Atomically claim an eligible record (`active` to `parked`) and repeat every
   age, lease, path, and Git safety check on the fresh record.
5. Default policy independently blocks untracked and ignored files. Ignored
   files are never staged automatically.
6. Park eligible changes with a commit and push that exact commit.
7. Verify the remote branch contains the exact parked commit.
8. Hold the registry claim lock across the final check and Git worktree removal,
   preventing a new Pi session from racing deletion.
9. Append the outcome to history and advance the registry to `recorded`.

Parking operations persist an operation ID and advance through `planned`,
`committed`, `pushed`, `remote-verified`, `removed`, and `recorded` states.
A session that opens the worktree before removal changes it back to `active`
and makes the operation terminal as `aborted`.

## Security invariants

- Every external process uses an argument array, never shell interpolation.
- Owner, repository, petname, branch namespace, and workspace paths are
  validated before use.
- Destructive targets must match the persisted
  `.flash/repos/<owner>/<repo>.git` and
  `worktrees/<owner>/<repo>/<petname>` layout, resolve beneath the same recorded
  root, and remain there after symlinks are resolved.
- Existing bare clones are checked against the canonical remote before reuse.
- Failure records contain metadata, never command output that might contain
  credentials.
- Mutating operations require an explicit user command or an explicitly enabled
  cleanup setting.
- External commands have bounded output and hard deadlines which terminate
  their Unix process groups.
