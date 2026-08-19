# Releases

## Release process

The public release is versioned from `package.json` and recorded in [CHANGELOG.md](../CHANGELOG.md). Release tags are pinned installation targets; use the exact Git command in the [Quick start](../README.md#quick-start) rather than an unpinned source.

Sandlot release refs commit the clean generated `dist` tree because Pi 0.84.2 clones Git sources and runs `npm install --omit=dev`; it does not run a TypeScript release build. Pi itself is a host prerequisite and development dependency rather than an install-time dependency, because Pi supplies extension APIs through its loader. Pi installs Sandlot's runtime dependencies for managed npm and Git sources and records every source in `~/.pi/agent/settings.json`. The package manifest declares `dist/index.js`, so Sandlot activates automatically in every new trusted Pi session; no `-e` flag or manual import is required. Use `pi list` to inspect the registered source and `pi update --extensions` to update unpinned sources.

Run the full verification sequence in [Development](development.md#verification) before publishing. The supported boundary is macOS x64 and arm64; Linux/Bubblewrap release verification remains deferred and Windows is unsupported.
