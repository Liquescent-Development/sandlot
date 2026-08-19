# Diagnostics

## Diagnostics

The footer shows `🔒 Sandlot` when initialization succeeds, `⚠ Sandlot failed` on failure, and a conspicuous unlocked status when disabled. RPC represents notifications and status through Pi's `extension_ui_request` protocol. Print and JSON modes write diagnostic notices to stderr so structured JSON stdout remains valid.

Run `/sandlot` for a redacted snapshot of platform, runtime state and generation, protected-tool ownership, aggregate policy counts, dependency warnings, and recent violations. Material runtime denials are shown as concise `Blocked by Sandlot:` notices; Sandlot suppresses only macOS's benign `sysctl-read kern.iossupportversion` probe, deduplicates equivalent wrapper reports, and keeps unfamiliar Runtime operation names visible through a safe generic notice.

Run `/sandlot-reload` after editing policy; it invokes Pi's reload lifecycle so the old runtime shuts down before a fresh extension instance starts. Pi's built-in `/reload` also reloads extensions, but `/sandlot-reload` makes the intended safety operation explicit. If the runtime is failed or poisoned, restart Pi after correcting the reported dependency or policy error.

Run `/sandlot graph` to verify that the installed extension resolves the exact Pi 0.84.2 host image pipeline and its pinned Photon module/WASM. The result reports only package versions, containment, and presence counts; it does not expose host paths.

## Local verification

From a trusted local checkout, run `npm run build`, install the checkout with `pi install "$(pwd)"`, launch Pi in that checkout, and run `/sandlot`. Confirm the footer shows `🔒 Sandlot` and the redacted snapshot reports `state: ready`. If it does not, do not continue with protected operations: correct the reported prerequisite or policy error, then reload or restart Pi.

For policy changes, consult [Configuration](configuration.md). For boundary limitations, consult [Security](security.md).
