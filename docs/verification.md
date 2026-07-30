# Release verification

Pi Flash is verified before release with:

1. TypeScript checking (`npm run check`).
2. Unit and Git-integration tests (`npm test`).
3. Package allowlist inspection (`npm run pack:check`).
4. A clean temporary Pi agent directory, installing the packed tarball with
   `pi install`, then confirming it appears in `pi list`.

The packed extension contains its runtime source and public documentation only;
test fixtures, local state, and development dependencies are excluded.

The release workflow repeats the checks, bumps the patch version, publishes
with npm trusted publishing and provenance, then commits the resulting package
version back to `main`.
