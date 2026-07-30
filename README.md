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
