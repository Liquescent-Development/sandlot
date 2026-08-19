import { assertProtectedOwnership } from "./guard.js";
import { classifySandboxViolations, formatClassifiedSandboxViolations } from "./violations.js";
/** Render only aggregate policy/security data; paths, commands, and secrets stay redacted. */
export function renderDiagnosticSnapshot(input) {
    const policy = input.runtime.policy;
    const lines = [
        "Sandlot diagnostics",
        `platform: ${input.platform}`,
        `state: ${input.runtime.state}`,
        `generation: ${input.runtime.generation}`,
        `active invocations: ${input.runtime.activeInvocationIds.length}`,
        `protected ownership: ${ownershipStatus(input.tools, input.sandlotSourcePath)}`,
    ];
    if (policy !== undefined) {
        lines.push(`policy: enabled=${String(policy.enabled)}, network mode=${policy.networkMode}, allowed domains=${policy.network.allowedDomains.length}, denied reads=${policy.filesystem.denyRead.length}, allowed writes=${policy.filesystem.allowWrite.length}, trusted custom tools=${policy.trustedCustomTools.length}`);
    }
    if (input.runtime.error !== undefined)
        lines.push(`error: ${redactDiagnosticText(input.runtime.error)}`);
    lines.push(`dependency warnings: ${input.dependencyWarnings.length}`);
    for (const warning of input.dependencyWarnings)
        lines.push(`- ${redactDiagnosticText(warning)}`);
    const formattedViolations = formatClassifiedSandboxViolations(classifySandboxViolations(input.violations).slice(-10))
        .split("\n")
        .filter((line) => line !== "");
    lines.push(`recent violations: ${formattedViolations.length}`);
    for (const violation of formattedViolations)
        lines.push(`- ${redactDiagnosticText(violation)}`);
    return lines.join("\n");
}
export function redactDiagnosticText(value) {
    return value
        .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@")
        .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._-]{4,}\b/gi, "<redacted>")
        .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)\s*=\s*[^\s;]+/gi, "$1=<redacted>")
        .replace(/\b((?:api[_ -]?key|token|password|secret)\s*[=:]\s*)\S+/gi, "$1<redacted>")
        .replace(/\bfile:\/\/\/(?:[^\s)\]}>;,:'"]*\/)*[^\s)\]}>;,:'"]+/gi, "file://<path>")
        .replace(/(^|[\s('"`\[])\/(?:[^\s)\]}>;,:'"]*\/)*[^\s)\]}>;,:'"]+/g, "$1<path>")
        .replace(/\b[A-Za-z]:\\(?:[^\s:;]+\\)*[^\s:;]+/g, "<path>");
}
function ownershipStatus(tools, sourcePath) {
    try {
        assertProtectedOwnership(tools, sourcePath);
        return "ok";
    }
    catch {
        return "failed";
    }
}
