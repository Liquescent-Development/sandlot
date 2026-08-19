# Development

## Development

Install dependencies from a clean checkout, then build before using the local extension:

```bash
npm ci
npm run build
pi install "$(pwd)"
```

Pi 0.84.2 treats a local file as one extension module, not as a package archive. To test a packed `.tgz`, install it with npm into an isolated directory and point `pi install` at the resulting `node_modules/sandlot` directory; the repository smoke tests automate this exact flow.

## Verification

Run from a clean checkout with prerequisites installed:

```bash
npm run typecheck
npm run build
npm test
SANDLOT_REQUIRE_INTEGRATION=1 npm run test:integration
npm run test:smoke
npm run pack:check
npm run release:verify
```

`npm test` runs unit and contract coverage. Required integration proves the supported macOS Seatbelt boundary and refuses to skip it. The release scripts clean-build before smoke tests. Smoke tests pack that final artifact, inspect `dist/index.js`, both compiled workers, README, SPEC, and LICENSE, install only the tarball plus exact lock-resolved dependencies under isolated Pi/npm state, and exercise real print, JSON, RPC, and interactive PTY modes. They also clone a pinned local Git release ref through real Pi without network access.

`pack:check` inspects the already-verified artifact and prints its dry-run contents; run `npm run build` first when invoking it alone. `release:verify` is the macOS first-release gate; `prepublishOnly` deliberately does not invoke `npm pack` or `npm publish`, avoiding recursive packaging.

See [Releases](releases.md) for the public release contract and [Security](security.md) for platform caveats.
