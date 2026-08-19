# Sandlot

Sandlot is a Pi package that automatically routes Pi's model-controlled shell, filesystem, and search operations through Anthropic's Sandbox Runtime. Pi remains the trusted host control plane; each protected tool invocation and user `!` command runs in a sandboxed child process and fails closed if Sandlot is unavailable.

Sandlot 0.1's first release supports macOS on x64 and arm64. Linux/Bubblewrap support is deferred and unverified for this release; do not treat source-level Linux paths as a supported security boundary. Windows is unsupported.

## Installation

Prerequisites:

- Node.js 22.19.0 or newer.
- Pi 0.84.2 (`@earendil-works/pi-coding-agent`).
- macOS with the built-in `sandbox-exec` facility and `ripgrep` (`brew install ripgrep`).
- Linux/Bubblewrap prerequisites and verification are deferred beyond the first release. Future Linux support is expected to require Bubblewrap, `socat`, `ripgrep`, the pinned architecture-specific seccomp helper, and distribution-specific user-namespace/AppArmor configuration; it is not a currently supported boundary.

Install a reviewed local checkout after building it:

```bash
git clone https://github.com/Liquescent-Development/sandlot.git
cd sandlot
npm ci
npm run build
pi install "$(pwd)"
```

Install an npm release directly:

```bash
pi install npm:sandlot@0.1.0
```

Pi also accepts Git package sources. Pin a reviewed release tag or commit:

```bash
pi install git:github.com/Liquescent-Development/sandlot@v0.1.0
```

Sandlot release refs commit the clean generated `dist` tree because Pi 0.84.2 clones Git sources and runs `npm install --omit=dev`; it does not run a TypeScript release build. Pi itself is a host prerequisite and development dependency rather than an install-time dependency, because Pi supplies extension APIs through its loader. Pi installs Sandlot's runtime dependencies for managed npm and Git sources and records every source in `~/.pi/agent/settings.json`. The package manifest declares `dist/index.js`, so Sandlot activates automatically in every new trusted Pi session; no `-e` flag or manual import is required. Use `pi list` to inspect the registered source and `pi update --extensions` to update unpinned sources.

Pi 0.84.2 treats a local file as one extension module, not as a package archive. To test a packed `.tgz`, install it with npm into an isolated directory and point `pi install` at the resulting `node_modules/sandlot` directory; the repository smoke tests automate this exact flow.

## Threat model

Sandlot treats model-generated commands, tool paths and content, network destinations, repository instructions, and user `!`/`!!` commands as untrusted. It replaces and verifies ownership of Pi's `bash`, `read`, `write`, `edit`, `ls`, `find`, and `grep` tools, and it blocks untrusted custom tool calls.

The trusted host control plane includes the Pi process, model-provider requests, configuration and session persistence, the TUI, Sandlot initialization, Sandbox Runtime, and every installed Pi extension. The sandboxed data plane consists of protected tool operations and their descendant processes. Because an extension cannot retroactively sandbox its host process, Sandlot is not a whole-Pi sandbox.

Defaults deny network access, Unix sockets, local binding, Apple Events, weaker isolation, reads of common credentials and Pi state, and writes outside the workspace or into project security/configuration files. Credential reads include Pi state and common SSH, cloud, GitHub CLI, Docker/container, Cargo, GnuPG, Maven, Gradle, npm, PyPI, Netrc, and Git credential locations; matching environment tokens are withheld. An initialization, ownership, configuration, helper, or sandbox failure leaves protected operations blocked; Sandlot never falls back to Pi's local implementation.

## Configuration

Sandlot reads strict JSON objects from these exact locations:

```text
~/.pi/agent/sandlot.json    trusted user policy and permission ceiling
<project>/.pi/sandlot.json  optional project-only restrictions
```

`PI_CODING_AGENT_DIR` replaces `~/.pi/agent` when set. Project policy is read only when Pi trusts the project (`ctx.isProjectTrusted()`); in noninteractive Pi modes use an existing trust decision or Pi's documented `--approve` behavior when project settings are intended. Unknown keys, invalid JSON, unreadable requested files, and widening project policy are hard errors. Relative policy paths resolve against the current project working directory and are canonicalized before use.

The curated user schema accepts:

- `enabled`.
- `network`: `allowedDomains`, `deniedDomains`, `deniedDomainReasons`, `allowUnixSockets`, `allowAllUnixSockets`, `allowLocalBinding`, `allowMachLookup`, and `tlsTerminate` (`caCertPath`, `caKeyPath`, `excludeDomains`, `extraCaCertPaths`). Network access always uses a strict allowlist.
- `filesystem`: `disabled`, `denyRead`, `allowRead`, `allowWrite`, `denyWrite`, and `allowGitConfig`.
- `credentials`: `files`, `envVars`, `allowPlaintextInject`, `awsPairs`, and `sigv4`. File entries use `path`, `mode`, and optional extraction/masking/injection fields; environment entries use `name`, `mode`, and the same relevant optional fields.
- `environment`: `passThrough`, `deny`, and `exposePiSessionMetadata`.
- `trustedCustomTools`, `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`, `allowAppleEvents`, `ripgrep`, `seccomp`, `bwrapPath`, and `socatPath`.

The project schema deliberately exposes only narrowing controls: network allow/deny lists and sockets, filesystem allow/deny lists, `trustedCustomTools`, and false-only forms of broad permissions or weaker isolation. A project allowlist must be covered by the user allowlist; project read/write paths must stay within user-granted paths; deny lists are unioned; and a project may remove trusted tools or dangerous capabilities but cannot add them. Custom `credentials.files` paths must use their canonical spelling; Sandlot rejects a symlink in the final path or any parent instead of silently trusting its target.

A secure user example that permits one API and CI metadata while preserving the default credential deny list is:

```json
{
  "network": {
    "allowedDomains": ["api.github.com"]
  },
  "filesystem": {
    "allowWrite": ["."]
  },
  "environment": {
    "passThrough": ["CI"],
    "deny": ["NPM_TOKEN"],
    "exposePiSessionMetadata": false
  },
  "trustedCustomTools": [],
  "enableWeakerNestedSandbox": false,
  "enableWeakerNetworkIsolation": false,
  "allowAppleEvents": false
}
```

A trusted project can tighten that ceiling:

```json
{
  "network": {
    "allowedDomains": [],
    "allowLocalBinding": false
  },
  "filesystem": {
    "allowWrite": ["./src"],
    "denyRead": ["./secrets"]
  },
  "trustedCustomTools": []
}
```

Credential entries default to denial. Masked, host-scoped injection requires `network.tlsTerminate`; the destination in `injectHosts` must also be covered by the effective domain allowlist. Sandbox Runtime rejects masking without TLS termination unless `credentials.allowPlaintextInject` is explicitly enabled. That plaintext escape hatch is less safe and is not recommended. Pi's provider credentials are used by trusted host-side model requests and normally do not belong in the sandbox environment.

Credential sources are retained only as in-process references for the active isolated service and those references are cleared during reset and shutdown. JavaScript and V8 do not guarantee physical memory zeroization, so this is reference clearing rather than a claim that every prior byte is overwritten.

`environment.passThrough` is an explicit grant, while `environment.deny` removes the named host or pass-through value. The wrapper still supplies fixed, host-independent operational values for `PATH`, `LANG`, and `LC_ALL`. Before Sandbox Runtime starts, Sandlot creates the current-UID-owned root, UID, and private session components of `/tmp/sandlot/<uid>/session-<unpredictable>/` with exact mode `0700`, then sets `TMPDIR`, `TMP`, and `TEMP` to that same session directory; host temporary-directory values can never replace it. Exact `0700` applies to those three protected hierarchy components; current-UID descendant directories created by ordinary commands may use routine modes, and cleanup validates their no-follow directory type, ownership, and stable identity before traversal. Sandlot grants only the session directory internally for runtime operation, not as a user policy write root. It removes the recorded directory only after every runner-owned command and supervised descendant has positively settled and the separate Sandbox Runtime service transport has positively terminated; transport close alone is not evidence that commands spawned by the runner have exited. An opening attempt is owned before asynchronous allocation or transport startup; reset cancels and consumes that attempt, and a parallel open is rejected. Concurrent reset and poison paths retain one generation-tagged service transport until its close positively confirms that generation, so another lifecycle caller cannot treat temporary transport absence as termination. Identity and ownership checks must still match, and any indeterminate termination or cleanup failure is surfaced while exact cleanup authority is retained. A name governed by credential policy is never passed through raw; its mask or denial takes precedence except for these fixed operational temporary variables. Pi session metadata is withheld unless `exposePiSessionMetadata` is true. Listing a name in `trustedCustomTools` trusts that tool's entire implementation: custom tools and extension code can access the host directly, outside Sandlot's protected data plane.

Sandlot's `/sandlot` snapshot is always redacted and aggregate-only. It does not accept disclosure controls or expose raw secrets, paths, command text, or full policy values.

## Diagnostics

The footer shows `🔒 Sandlot` when initialization succeeds, `⚠ Sandlot failed` on failure, and a conspicuous unlocked status when disabled. RPC represents notifications and status through Pi's `extension_ui_request` protocol. Print and JSON modes write diagnostic notices to stderr so structured JSON stdout remains valid.

Run `/sandlot` for a redacted snapshot of platform, runtime state and generation, protected-tool ownership, aggregate policy counts, dependency warnings, and recent violations. Material runtime denials are shown as concise `Blocked by Sandlot:` notices; Sandlot suppresses only macOS's benign `sysctl-read kern.iossupportversion` probe, deduplicates equivalent wrapper reports, and keeps unfamiliar Runtime operation names visible through a safe generic notice. Run `/sandlot-reload` after editing policy; it invokes Pi's reload lifecycle so the old runtime shuts down before a fresh extension instance starts. Pi's built-in `/reload` also reloads extensions, but `/sandlot-reload` makes the intended safety operation explicit. If the runtime is failed or poisoned, restart Pi after correcting the reported dependency or policy error.

Run `/sandlot graph` to verify that the installed extension resolves the exact Pi 0.84.2 host image pipeline and its pinned Photon module/WASM. The result reports only package versions, containment, and presence counts; it does not expose host paths.

## Explicit disable

> **Warning:** setting `"enabled": false` disables the security boundary. Protected operations then run locally on the host.

Only the trusted user policy at `~/.pi/agent/sandlot.json` may disable Sandlot:

```json
{
  "enabled": false
}
```

Sandlot reports an unlocked status and warning in every Pi mode. Project policy cannot set `enabled`, so repository content cannot disable protection or widen the user ceiling. Remove the setting and run `/sandlot-reload` (or restart Pi) to restore sandboxing.

## Limitations

- Linux/Bubblewrap is deferred and unverified for Sandlot 0.1's first release, and Windows is unsupported. Do not interpret extension loading on either as a security boundary.
- Pi, provider HTTP traffic, configuration, sessions, and installed extensions remain trusted host-side code. Sandlot does not sandbox its own loader or third-party extension initialization, commands, event handlers, or direct host APIs.
- Third-party extensions can replace tools or register custom tools. Sandlot blocks detected protected-tool replacement and denies custom tool calls unless explicitly trusted, but installing an extension already grants its initialization code host access. Review every extension before installation.
- Domain allowlisting limits destinations, not information flow. Allowing `github.com` or a wildcard can permit exfiltration to another account, repository, URL path, query, header, or request body on that domain. Use the narrowest hosts possible; TLS termination enables credential substitution but does not make a broad destination safe.
- Files a model writes may be unsafe when a human later runs them outside Pi. Sandlot constrains execution, not the meaning of generated code.
- On macOS, Sandlot kills the wrapper process group and performs best-effort supervision of detached descendants. It cannot guarantee termination when a hostile process deliberately creates a new session and reparents between observations; a race-free guarantee requires Sandbox Runtime or platform support.
- On macOS, normal shell `mktemp` use is routed through Sandlot's immutable, trusted-readable PATH shim so implicit forms (including empty `-t ''` and `--tmpdir=`) create beneath the confined `TMPDIR`. Absolute `/usr/bin/mktemp` calls, and applications that deliberately use `_CS_DARWIN_USER_TEMP_DIR`, remain an upstream macOS/Sandbox Runtime limitation; Sandlot does not grant that host directory.
- Linux/Bubblewrap release verification is deliberately deferred, not merely unavailable on one host. Sandbox Runtime's mandatory nested-path scan behavior and general Linux lexical-alias collapse remain upstream/runtime limitations to resolve before Linux support is released.
- Sandbox Runtime is a pinned research-preview dependency. Platform primitives and Linux user-namespace/AppArmor policy can prevent initialization; Sandlot fails closed rather than weakening policy automatically.

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

`npm test` runs unit and contract coverage. Required integration proves the supported macOS Seatbelt boundary and refuses to skip it. The release scripts clean-build before smoke tests. Smoke tests pack that final artifact, inspect `dist/index.js`, both compiled workers, README, SPEC, and LICENSE, install only the tarball plus exact lock-resolved dependencies under isolated Pi/npm state, and exercise real print, JSON, RPC, and interactive PTY modes. They also clone a pinned local Git release ref through real Pi without network access. `pack:check` inspects the already-verified artifact and prints its dry-run contents; run `npm run build` first when invoking it alone. `release:verify` is the macOS first-release gate; `prepublishOnly` deliberately does not invoke `npm pack` or `npm publish`, avoiding recursive packaging.
