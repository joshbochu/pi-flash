# Replacement-process handoff

Pi session switching cannot change the process working directory, so Pi Flash
uses a Unix process handoff only for interactive TUI commands.

1. The command completes all validation, Git work, registry writes, and Pi
   launcher preflight while the initiating session is idle.
2. It calls Pi's graceful shutdown API. Pi restores terminal state and emits
   the extension shutdown event.
3. The shutdown handler starts a fresh Pi child in the target worktree with
   inherited stdio and no session arguments.
4. The initiating Pi remains alive while the child runs, keeping the terminal's
   foreground job intact. After the replacement exits, the initiating Pi
   finishes shutdown and control returns to the shell.

The child receives paths as direct process arguments, without a shell. This
avoids command injection from repository names or workspace paths. A failed
preflight or non-TUI invocation never starts the handoff. A worktree created
before a failed handoff remains recoverable through the registry and history.

`test/handoff.test.mjs` proves the key race invariant with a parent/child
fixture: the initiating process remains alive for the replacement's lifetime,
and the replacement observes the literal target directory even when it contains
shell metacharacters.
