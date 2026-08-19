# Configuration

Sandlot reads strict JSON objects from these exact locations:

```text
~/.pi/agent/sandlot.json    trusted user policy and permission ceiling
<project>/.pi/sandlot.json  optional project-only restrictions
```

`PI_CODING_AGENT_DIR` replaces `~/.pi/agent` when set. Project policy is read only when Pi trusts the project (`ctx.isProjectTrusted()`); in noninteractive Pi modes use an existing trust decision or Pi's documented `--approve` behavior when project settings are intended. Unknown keys, invalid JSON, unreadable requested files, and widening project policy are hard errors. Relative policy paths resolve against the current project working directory and are canonicalized before use.

## User policy

The curated user schema accepts `enabled`; `network`; `filesystem`; `credentials`; `environment`; `trustedCustomTools`; `enableWeakerNestedSandbox`; `enableWeakerNetworkIsolation`; `allowAppleEvents`; `ripgrep`; `seccomp`; `bwrapPath`; and `socatPath`. Network access always uses a strict allowlist. The full schema and semantics are in [SPEC.md](../SPEC.md).

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

Credential entries default to denial. Masked, host-scoped injection requires `network.tlsTerminate`; the destination in `injectHosts` must also be covered by the effective domain allowlist. Sandbox Runtime rejects masking without TLS termination unless `credentials.allowPlaintextInject` is explicitly enabled. That plaintext escape hatch is less safe and is not recommended. Pi's provider credentials are used by trusted host-side model requests and normally do not belong in the sandbox environment.

`environment.passThrough` is an explicit grant, while `environment.deny` removes the named host or pass-through value. A name governed by credential policy is never passed through raw; its mask or denial takes precedence. Listing a name in `trustedCustomTools` trusts that tool's entire implementation: custom tools and extension code can access the host directly, outside Sandlot's protected data plane. Review trusted extensions before installation.

## Project policy

The project schema deliberately exposes only narrowing controls: network allow/deny lists and sockets, filesystem allow/deny lists, `trustedCustomTools`, and false-only forms of broad permissions or weaker isolation. A project allowlist must be covered by the user allowlist; project read/write paths must stay within user-granted paths; deny lists are unioned; and a project may remove trusted tools or dangerous capabilities but cannot add them.

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

## Temporary data and diagnostics

Before Sandbox Runtime starts, Sandlot creates the current-UID-owned root, UID, and private session components of `/tmp/sandlot/<uid>/session-<unpredictable>/` with exact mode `0700`, then sets `TMPDIR`, `TMP`, and `TEMP` to that same session directory; host temporary-directory values can never replace it. Sandlot grants only the session directory internally for runtime operation, not as a user policy write root.

Credential sources are retained only as in-process references for the active isolated service and those references are cleared during reset and shutdown. JavaScript and V8 do not guarantee physical memory zeroization, so this is reference clearing rather than a claim that every prior byte is overwritten. Sandlot's `/sandlot` snapshot is always redacted and aggregate-only. It does not accept disclosure controls or expose raw secrets, paths, command text, or full policy values.

For operating status and reload behavior, see [Diagnostics](diagnostics.md). For security boundaries and caveats, see [Security](security.md).
