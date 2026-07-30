# Pi Flash

Launch a fresh, isolated [Pi](https://pi.dev) session in a Git worktree selected
from your GitHub repositories.

Install the public extension with:

```bash
pi install npm:@joshbochu/pi-flash
```

After installation, `/flash` opens a repository picker and `/flash <query>`
launches a confident match in a new worktree. Setup configures repository
sources, the workspace root, matching, and conservative cleanup behavior.

On first use, `/flash` opens a welcome overlay. It verifies `git`, `gh`, and
Pi, discovers your GitHub account and organizations through `gh`, lets you
enable the accounts to index, and records your chosen workspace root. Pi Flash
stores only its own configuration below `PI_CODING_AGENT_DIR` (or
`~/.pi/agent` when that variable is unset).

Use `/flash billing` to search repository names. Include a slash, as in
`/flash acme/billing`, to match an exact owner/repository name. A high-scoring,
clear result launches directly; otherwise the searchable picker shows the best
local matches and their descriptions. `/flash refresh` explicitly replaces the
cached index; an index older than 24 hours refreshes in the background.

## Commands

- `/flash` — searchable repository picker.
- `/flash <name>` — match repository names only; launch only when confident.
- `/flash <owner>/<name>` — match canonical names; exact matches launch.
- `/flash setup` or `/flash config` — choose sources and workspace root.
- `/flash refresh` — refresh the local GitHub cache now.
- `/flash history` — show recent recoverable worktree events.
- `/flash clean` — review inactive managed worktrees; confirmation is required
  before any removal.
- `/flash clean enable|disable` — control background cleanup after the explicit
  initial report-only default.
- `/flash clean config` — choose untracked and ignored-file policies.

Pi Flash supports macOS and Linux. It uses `gh` for GitHub.com repository
discovery and `git` for all clone, fetch, branch, and worktree work.

## Storage and cleanup

The selected workspace defaults to `~/dev`. A repository uses one compact
partial bare clone at `<workspace>/.flash/repos/<owner>/<repo>.git`; every
launch creates a separate branch and worktree at
`<workspace>/worktrees/<owner>/<repo>/<petname>`.

Cleanup is intentionally conservative. It starts report-only, considers only
worktrees already registered by Pi Flash, skips active or recent worktrees, and
blocks every untracked file (including ignored files) by default. When enabled,
cleanup pushes and verifies the parking branch before removing a local
worktree. It never stages ignored files.

## Development

```bash
npm install --legacy-peer-deps
npm run check
npm test
pi -e ./src/index.ts
```

See [docs/architecture.md](docs/architecture.md) and
[docs/acceptance.md](docs/acceptance.md) for the product contract.

## License

MIT
