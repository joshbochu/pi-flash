# Release verification

Pi Flash is verified before release with:

1. TypeScript checking (`npm run check`).
2. Unit, multi-process concurrency, detached-worker, Git integration, handoff,
   and compiled-distribution smoke tests (`npm test`).
3. Package allowlist inspection (`npm run pack:check`).
4. A clean temporary npm prefix and Pi agent directory, installing the packed
   tarball without its host peers, loading the extension through the current Pi
   runtime, and executing the packaged worker directly.

The packed extension contains its precompiled extension/worker bundles, source
maps, and public documentation only; TypeScript sources, test fixtures, local
state, and development dependencies are excluded.

The release workflow repeats the checks, handles the explicitly requested first
publish separately, and uses npm trusted publishing for later versions.
