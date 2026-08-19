import { describe, expect, it } from "vitest";
import { redactDiagnosticText, renderDiagnosticSnapshot } from "../../src/diagnostics.js";

describe("diagnostic redaction", () => {
  it("redacts file URLs and quoted POSIX paths without retaining host path components", () => {
    const redacted = redactDiagnosticText(
      `failed at file:///Users/alice/private/token.json and '/Users/alice/private/other.json' or \"/private/tmp/secret\"`,
    );

    expect(redacted).toBe("failed at file://<path> and '<path>' or \"<path>\"");
    expect(redacted).not.toContain("alice");
    expect(redacted).not.toContain("private/tmp");
  });
});

describe("diagnostic violation selection", () => {
  it("retains a targetless material denial", () => {
    const rendered = renderDiagnosticSnapshot({
      platform: "darwin",
      runtime: { state: "ready", generation: 1, policy: undefined, error: undefined, activeInvocationIds: [] },
      dependencyWarnings: [],
      tools: [],
      sandlotSourcePath: "/trusted/sandlot.js",
      violations: [{ line: "bash(42) deny(1) process-fork" }],
    });

    expect(rendered).toContain("recent violations: 1");
    expect(rendered).toContain("Blocked by Sandlot: fork process");
  });

  it("deduplicates newest-to-oldest before retaining the newest ten in chronological order", () => {
    const rendered = renderDiagnosticSnapshot({
      platform: "darwin",
      runtime: { state: "ready", generation: 1, policy: undefined, error: undefined, activeInvocationIds: [] },
      dependencyWarnings: [],
      tools: [],
      sandlotSourcePath: "/trusted/sandlot.js",
      violations: [
        { line: "deny http-request https://old.invalid/0" },
        { line: "deny http-request https://old.invalid/1" },
        { line: "deny http-request https://duplicate.invalid/value" },
        ...Array.from({ length: 10 }, (_, index) => ({ line: `deny http-request https://new.invalid/${index}` })),
        { line: "deny http-request https://duplicate.invalid/value" },
        ...Array.from({ length: 12 }, () => ({ line: "bash(1) deny(1) sysctl-read kern.iossupportversion" })),
      ],
    });

    expect(rendered).toContain("recent violations: 10");
    expect(rendered).not.toContain("iossupportversion");
    expect(rendered).not.toContain("https://old.invalid/0");
    expect(rendered).not.toContain("https://old.invalid/1");
    expect(rendered).not.toContain("https://new.invalid/0");
    expect(rendered).toContain("Blocked by Sandlot: HTTP request https://new.invalid/1");
    expect(rendered.indexOf("https://new.invalid/1")).toBeLessThan(rendered.indexOf("https://duplicate.invalid/value"));
  });
});
