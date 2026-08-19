<p align="center">
  <img src="docs/assets/sandlot-logo.png" alt="Sandlot logo" width="320">
</p>

<p align="center">
  <a href="https://github.com/Liquescent-Development/sandlot/releases"><img src="https://img.shields.io/github/v/release/Liquescent-Development/sandlot?display_name=tag" alt="Latest release"></a>
  <a href="https://github.com/Liquescent-Development/sandlot/actions/workflows/security.yml?query=branch%3Amain"><img src="https://github.com/Liquescent-Development/sandlot/actions/workflows/security.yml/badge.svg?branch=main" alt="macOS security workflow"></a>
  <img src="https://img.shields.io/badge/support-macOS%20x64%20%7C%20arm64-brightgreen" alt="macOS x64 and arm64 supported">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="AGPL-3.0 license"></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img src="https://img.shields.io/badge/Pi-0.84.2-5c6ac4" alt="Pi 0.84.2"></a>
</p>

# Sandlot

Sandlot is a Pi extension that routes Pi's model-controlled shell, filesystem, and search operations through [Anthropic's experimental Sandbox Runtime](https://github.com/anthropics/anthropic-experimental/tree/main/sandbox-runtime) (`anthropic-experimental/sandbox-runtime`). The underlying macOS Seatbelt boundary comes from Sandbox Runtime. Sandlot owns the Pi integration, policy composition, protected-tool routing, lifecycle management, diagnostics, and fail-closed behavior around that boundary.

## Why Sandlot?

An agent can be useful only when it can act, but model-generated commands, tool paths, network destinations, and repository instructions are not trustworthy by default. Sandlot adds a narrow, fail-closed boundary around Pi's protected operations while retaining Pi's familiar workflow and making its status visible.

## Quick start

Prerequisites:

- Node.js 22.19.0 or newer.
- [Pi 0.84.2](https://github.com/badlogic/pi-mono) (`@earendil-works/pi-coding-agent`).
- macOS x64 or arm64 with the built-in `sandbox-exec` facility and `ripgrep` (`brew install ripgrep`).

Install the pinned release:

```bash
pi install git:github.com/Liquescent-Development/sandlot@v0.1.0
```

Launch Pi in a trusted project, then run `/sandlot`. A `🔒 Sandlot` footer and a snapshot containing `state: ready` confirm that the extension is ready. If initialization fails, protected operations remain blocked; correct the reported prerequisite or policy error and restart Pi. To update, explicitly install a newer reviewed tag with the same command; Sandlot does not silently move this pinned release.

### Secure defaults

Sandlot denies network access, Unix sockets, local binding, Apple Events, weaker isolation, common credentials, and Pi state by default. Project writes inside the workspace are allowed except for protected configuration and security paths, including project `.pi` settings and Git security/configuration files. Project policy can narrow a trusted user's ceiling but cannot widen it. See the [security guide](docs/security.md) before allowing a network destination, credential, or custom tool.

### Small configuration example

Only a trusted user can disable the boundary. This is useful for diagnosis, but it intentionally runs protected operations on the host:

<!-- sandlot-policy: user -->
```json
{
  "enabled": false
}
```

Remove the setting and run `/sandlot-reload` (or restart Pi) to restore sandboxing.

## How it works

Sandlot verifies and replaces Pi's `bash`, `read`, `write`, `edit`, `ls`, `find`, and `grep` tools, blocks untrusted custom tool calls, and starts an isolated Sandbox Runtime service for protected operations. The trusted host control plane still includes Pi, model-provider requests, configuration and session persistence, the TUI, Sandlot initialization, Sandbox Runtime, and installed Pi extensions. Sandlot is not a whole-Pi sandbox: an extension cannot retroactively sandbox its host process.

## Supported platforms

Sandlot 0.1 supports macOS on x64 and arm64. Linux/Bubblewrap support is deferred and unverified for this release; do not treat source-level Linux paths as a supported security boundary. Windows is unsupported.

## Documentation

- [Configuration](docs/configuration.md) — trusted user and project policy.
- [Security](docs/security.md) — threat model, defaults, and limitations.
- [Diagnostics](docs/diagnostics.md) — status, reload, and troubleshooting.
- [Development](docs/development.md) — local setup and verification.
- [Releases](docs/releases.md) — packaging and release checks.
- [Specification](SPEC.md) — detailed implementation contract.
- [Changelog](CHANGELOG.md) — released changes.

## Development

For a local checkout, follow the [development guide](docs/development.md). Pi Git installations load the committed `dist` tree because Pi 0.84.2 does not run a TypeScript release build for Git sources.

## License

Sandlot is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).
