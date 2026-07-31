# Replacement-process handoff

Pi session switching cannot change the process working directory, so Pi Flash
uses a Unix process handoff for interactive TUI commands. On Node.js, the normal
path is a same-process handoff.

1. The command completes all validation, Git work, registry writes, and Pi
   launcher preflight while the initiating session is idle.
2. It calls Pi's graceful shutdown API. Pi restores terminal state and emits
   every extension shutdown event.
3. The shutdown handler arms a synchronous process-exit listener.
4. At the final shutdown boundary, `execve` replaces the initiating Pi with a
   blank Pi in the target worktree.

The Node.js replacement keeps the same PID, process group, and standard terminal
file descriptors. Repeated `/flash` launches therefore do not accumulate
dormant Pi parents, and the user's shell does not reclaim the foreground job
between sessions. A runtime such as Bun that does not expose `process.execve`
uses the previous inherited-stdio child handoff and keeps its parent alive until
the replacement exits.

Paths are passed as direct process arguments, without a shell. This avoids
command injection from repository names or workspace paths. The launcher is
resolved before shutdown. A worktree created before any later handoff failure
remains recoverable through the registry and history.

`test/handoff.test.mjs` executes the production controller and proves both key
invariants: the replacement retains the initiating PID and observes the literal
target directory even when it contains shell metacharacters.
