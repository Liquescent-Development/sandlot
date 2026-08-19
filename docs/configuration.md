# Configuration

Sandlot reads strict JSON objects from these exact locations:

```text
~/.pi/agent/sandlot.json    trusted user policy and permission ceiling
<project>/.pi/sandlot.json  optional project-only restrictions
```

`PI_CODING_AGENT_DIR` replaces `~/.pi/agent` when set. Project policy is read only when Pi trusts the project (`ctx.isProjectTrusted()`); in noninteractive Pi modes use an existing trust decision or Pi's documented `--approve` behavior when project settings are intended. Unknown keys, invalid JSON, unreadable requested files, and widening project policy are hard errors. Relative policy paths resolve against the current project working directory and are canonicalized before use.

## User policy

### Unrestricted outbound network (trusted user only)

Use this exact user-policy object only when the trusted user intentionally needs to remove outbound host/domain filtering:

<!-- sandlot-policy: user -->
```json
{
  "network": {
    "mode": "unrestricted"
  }
}
```

`network.mode: "unrestricted"` removes only outbound host/domain filtering. It does not relax filesystem, process, environment, credential, Unix-socket, local-binding, or lifecycle protections. The filtered mode remains the default and retains its strict allowlist behavior, including denying outbound destinations when the allowlist is empty.

This is trusted-user-only: project policy cannot select it. In this mode the `network` object must have no sibling fields, and any project `network` block is rejected. Because any sandbox-readable data can be sent to any destination, use this mode only for commands and inputs you trust. Credential injection is unavailable; mask-mode credentials receive sentinel values and have no real injection target.

The strict user-policy object accepts these controls:

- `enabled` enables or disables Sandlot for the trusted user.
- `network` either accepts only `mode: "unrestricted"` as described above, or (in the default filtered mode) accepts `allowedDomains`, `deniedDomains`, `deniedDomainReasons`, `allowUnixSockets`, `allowAllUnixSockets`, `allowLocalBinding`, `allowMachLookup`, and `tlsTerminate`. `tlsTerminate` accepts `caCertPath`, `caKeyPath`, `excludeDomains`, and `extraCaCertPaths`.
- `filesystem` accepts `disabled`, `denyRead`, `allowRead`, `allowWrite`, `denyWrite`, and `allowGitConfig`.
- `credentials` accepts `files`, `envVars`, `allowPlaintextInject`, `awsPairs`, and `sigv4`. File credentials use `path`, `mode`, and optional `extract`, `onExtractNoMatch`, `decode`, `maskClaims`, `maskDuplicates`, and `injectHosts`; environment credentials use the corresponding `name` form. AWS pairs name access-key, secret-key, and optional session-token variables. `sigv4` controls `streaming`, `presigned`, and `sigv4a`.
- `environment` accepts `passThrough`, `deny`, and `exposePiSessionMetadata`.
- `trustedCustomTools`, `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`, `allowAppleEvents`, `ripgrep.command`, `seccomp.applyPath`, `seccomp.argv0`, `bwrapPath`, and `socatPath` control trusted extensions and platform/runtime integration.

Sandlot validates every policy object strictly. User policy sets the permission
ceiling; trusted project policy may only narrow it. Unknown keys, invalid JSON,
and any attempted widening are errors that leave protected operations blocked.

A secure user policy can permit one API and CI metadata while preserving the default credential deny list:

<!-- sandlot-policy: user -->
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

Credential entries default to denial. In filtered mode, masked, host-scoped injection requires `network.tlsTerminate`; the destination in `injectHosts` must also be covered by the effective domain allowlist. Sandbox Runtime rejects masking without TLS termination unless `credentials.allowPlaintextInject` is explicitly enabled. That plaintext escape hatch is less safe and is not recommended. In unrestricted mode, injection is unavailable: `injectHosts` is rejected and mask-mode credentials use sentinel values with no real injection target. Pi's provider credentials are used by trusted host-side model requests and normally do not belong in the sandbox environment.

`environment.passThrough` is an explicit grant, while `environment.deny` removes the named host or pass-through value. A name governed by credential policy is never passed through raw; its mask or denial takes precedence. Listing a name in `trustedCustomTools` trusts that tool's entire implementation: custom tools and extension code can access the host directly, outside Sandlot's protected data plane. Review trusted extensions before installation.

## Project policy

The project schema deliberately exposes only narrowing controls. Its `network` object accepts `allowedDomains`, `deniedDomains`, `allowUnixSockets`, `allowMachLookup`, and false-only `allowAllUnixSockets` and `allowLocalBinding`—except when the trusted user selects `network.mode: "unrestricted"`, in which case every project `network` block is rejected. Its `filesystem` object accepts `denyRead`, `allowRead`, `allowWrite`, `denyWrite`, and false-only `disabled` and `allowGitConfig`. The top-level project controls are `trustedCustomTools` plus false-only `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`, and `allowAppleEvents`. A project allowlist must be covered by the user allowlist; project read/write paths must stay within user-granted paths; deny lists are unioned; and a project may remove trusted tools or dangerous capabilities but cannot add them.

A trusted project can tighten that ceiling:

<!-- sandlot-policy: project -->
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

Custom `credentials.files` paths must use their canonical spelling; Sandlot rejects a symlink in the final path or any parent instead of silently trusting its target. Project policy cannot set `enabled`, so repository content cannot disable protection or widen the user ceiling.

## Explicit disable

> **Warning:** setting `"enabled": false` disables the security boundary. Protected operations then run locally on the host.

Only the trusted user policy at `~/.pi/agent/sandlot.json` may disable Sandlot:

<!-- sandlot-policy: user -->
```json
{
  "enabled": false
}
```

Project policy cannot disable Sandlot. Remove the setting and run `/sandlot-reload` (or restart Pi) to restore protection.

## Temporary data and diagnostics

Before Sandbox Runtime starts, Sandlot creates the current-UID-owned root, UID, and private session components of `/tmp/sandlot/<uid>/session-<unpredictable>/` with exact mode `0700`, then sets `TMPDIR`, `TMP`, and `TEMP` to that same session directory; host temporary-directory values can never replace it. Sandlot grants only the session directory internally for runtime operation, not as a user policy write root.

Exact `0700` applies to those three protected hierarchy components; current-UID descendant directories created by ordinary commands may use routine modes, and cleanup validates their no-follow directory type, ownership, and stable identity before traversal. Sandlot removes the recorded directory only after every runner-owned command and supervised descendant has positively settled and the separate Sandbox Runtime service transport has positively terminated; transport close alone is not evidence that commands spawned by the runner have exited. An opening attempt is owned before asynchronous allocation or transport startup; reset cancels and consumes that attempt, and a parallel open is rejected. Concurrent reset and poison paths retain one generation-tagged service transport until its close positively confirms that generation, so another lifecycle caller cannot treat temporary transport absence as termination. Identity and ownership checks must still match, and any indeterminate termination or cleanup failure is surfaced while exact cleanup authority is retained.

Credential sources are retained only as in-process references for the active isolated service and those references are cleared during reset and shutdown. JavaScript and V8 do not guarantee physical memory zeroization, so this is reference clearing rather than a claim that every prior byte is overwritten. Sandlot's `/sandlot` snapshot is always redacted and aggregate-only. It does not accept disclosure controls or expose raw secrets, paths, command text, or full policy values.

For operating status and reload behavior, see [Diagnostics](diagnostics.md). For security boundaries and caveats, see [Security](security.md).
