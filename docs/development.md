# Development

## Development

## Prerequisites

- Node.js 22.19.0 or newer and the checked-in npm lockfile.
- Pi 0.84.2 (`@earendil-works/pi-coding-agent`) as the host development dependency.
- macOS x64 or arm64 with `sandbox-exec` and `ripgrep` (`brew install ripgrep`) for the supported security boundary.

Install dependencies from a clean checkout, then build before using the local extension:

```bash
npm ci
npm run build
pi install "$(pwd)"
```

Pi 0.84.2 treats a local file as one extension module, not as a package archive. To test a packed `.tgz`, install it with npm into an isolated directory and point `pi install` at the resulting `node_modules/sandlot` directory; the repository smoke tests automate this exact flow.

## Contributing

Keep changes narrowly scoped, preserve the public security caveats, and add or update regression tests before implementation. Run the relevant test subset while developing, then use the release gate before proposing a stable release. Do not claim Linux support: Linux/Bubblewrap release verification remains deferred.

## Verification

The complete macOS release gate is the single command `npm run release:verify`:

```bash
npm run release:verify
```

`npm test` runs unit and contract coverage. Required integration proves the supported macOS Seatbelt boundary and refuses to skip it. The release scripts clean-build before smoke tests. Smoke tests pack that final artifact, inspect `dist/index.js`, both compiled workers, README, SPEC, and LICENSE, install only the tarball plus exact lock-resolved dependencies under isolated Pi/npm state, and exercise real print, JSON, RPC, and interactive PTY modes. They also clone a pinned local Git release ref through real Pi without network access.

`pack:check` inspects the already-verified artifact and prints its dry-run contents; run `npm run build` first when invoking it alone. `release:verify` is the macOS first-release gate; `prepublishOnly` deliberately does not invoke `npm pack` or `npm publish`, avoiding recursive packaging.

See [Releases](releases.md) for the public release contract and [Security](security.md) for platform caveats.
