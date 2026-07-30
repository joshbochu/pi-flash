# Replacement-process handoff

Pi session switching cannot change the process working directory, so Pi Flash
uses a Unix process handoff only for interactive TUI commands.

1. The command completes all validation, Git work, registry writes, and Pi
   launcher preflight while the initiating session is idle.
2. It creates a small inherited-stdio shell child that waits for the parent PID
   to disappear, then changes into the target worktree and `exec`s `pi` with no
   session arguments.
3. It calls Pi's graceful shutdown API. Pi restores terminal state and exits.
4. The waiting child becomes the fresh Pi process in the target worktree.

The child receives paths as positional arguments, never via shell
interpolation. This avoids command injection from repository names or workspace
paths. A failed preflight or non-TUI invocation never starts the handoff. A
worktree created before a failed handoff remains recoverable through the
registry and history.

`test/handoff.test.mjs` proves the key race invariant with a parent/child
fixture: the replacement process observes the literal target directory only
after the parent exits, including paths containing shell metacharacters.
