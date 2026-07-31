# Acceptance contract

## Setup and index

- First `/flash` opens setup rather than failing mysteriously.
- Setup verifies `git`, `gh`, and GitHub authentication, discovers the active
  account and organizations, records enabled sources, and lets the user choose
  a workspace root.
- A completed setup creates a local index.
- A populated index older than 24 hours refreshes in the background.
- The refresh worker survives replacement of the initiating Pi process.
- A failed refresh keeps the last complete index.
- Empty repositories are omitted without aborting an otherwise valid refresh.
- Disabling a source removes it from cached results immediately.

## Matching

- `/flash` opens a live picker.
- `/flash billing` scores repository names only.
- `/flash acme/billing` scores canonical owner/repository names.
- Exact canonical matches launch immediately.
- A candidate launches only when its score meets the threshold and its lead
  over the second candidate meets the configured margin.
- Duplicate repository names under different owners are ambiguous.
- Descriptions are visible in the picker but never influence score.

## Git workspace

- Each successful invocation creates a distinct worktree and branch.
- Concurrent first invocations share one serialized bare clone and still create
  distinct worktrees.
- Repositories with the same name under different owners cannot share storage.
- The remote default branch is fetched before normal launch.
- Active GitHub login discovery overlaps repository preparation instead of
  adding a second serial network round trip.
- A first clone does not perform a redundant fetch.
- Fetch uses three attempts total by default.
- A failed fetch with a verified cached ref creates a visibly stale worktree;
  a repository without a cached ref does not launch.
- A remote mismatch prevents bare-clone reuse.

## Pi handoff

- A successful launch replaces the current Pi in the same terminal.
- The replacement Pi starts in the created worktree.
- The new session is blank and uses normal Pi defaults.
- Exiting the replacement Pi returns to the shell, not the initiating Pi.
- Handoff failure leaves a usable terminal and records the recovery path.

## History and cleanup

- Managed worktrees record their repository, branch, path, timestamps, base
  commit, and lifecycle state.
- `/flash history` exposes recovery branch and commit information.
- Report-only cleanup never changes a repository.
- Default cleanup blocks every untracked file, including ignored files.
- The optional include-unignored policy stages only files Git does not ignore;
  ignored files still block deletion unless the user explicitly enables their
  discard policy.
- A local worktree is removed only after its remote parked commit is verified.
- A fresh active-session lease invalidates an earlier cleanup scan.
- Cleanup removal holds the registry claim lock, so session startup cannot race
  the destructive boundary.
- Interrupted committed, pushed, or verified operations resume idempotently.
- Every cleanup proposal and result is recoverable from history.

## Distribution

- The packed tarball installs in a clean Pi agent directory before release.
- After the deferred public release,
  `pi install npm:@joshbochu/pi-flash` installs the package.
- npm package contents exclude test-only and development-only files.
- Type checking, tests, package verification, and clean-room installation pass
  before automatic publication.
