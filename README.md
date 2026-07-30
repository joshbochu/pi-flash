# Pi Flash

Launch a fresh, isolated [Pi](https://pi.dev) session in a Git worktree selected
from your GitHub repositories.

Pi Flash is currently under active development. Its public package will install
with:

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
