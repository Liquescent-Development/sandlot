# Security

## Threat model

Sandlot treats model-generated commands, tool paths and content, network destinations, repository instructions, and user `!`/`!!` commands as untrusted. It replaces and verifies ownership of Pi's `bash`, `read`, `write`, `edit`, `ls`, `find`, and `grep` tools, and it blocks untrusted custom tool calls.

The trusted host control plane includes the Pi process, model-provider requests, configuration and session persistence, the TUI, Sandlot initialization, [Sandbox Runtime](https://github.com/anthropics/anthropic-experimental/tree/main/sandbox-runtime), and every installed Pi extension. The sandboxed data plane consists of protected tool operations and their descendant processes. Because an extension cannot retroactively sandbox its host process, Sandlot is not a whole-Pi sandbox.

Defaults deny network access, Unix sockets, local binding, Apple Events, weaker isolation, reads of common credentials and Pi state, and writes outside the workspace or into project security/configuration files. Credential reads include Pi state and common SSH, cloud, GitHub CLI, Docker/container, Cargo, GnuPG, Maven, Gradle, npm, PyPI, Netrc, and Git credential locations; matching environment tokens are withheld. An initialization, ownership, configuration, helper, or sandbox failure leaves protected operations blocked; Sandlot never falls back to Pi's local implementation.

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

Use the [configuration guide](configuration.md) to apply the narrowest policy possible, and [Diagnostics](diagnostics.md) to investigate a failure without exposing sensitive values.
