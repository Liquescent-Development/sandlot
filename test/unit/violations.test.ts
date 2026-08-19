import { describe, expect, it } from "vitest";
import { classifySandboxViolations, formatSandboxViolations } from "../../src/violations.js";

describe("Sandbox Runtime violation presentation", () => {
  it("suppresses only the exact benign iossupportversion probe", () => {
    expect(classifySandboxViolations([
      { line: "deny sysctl-read kern.iossupportversion" },
      { line: "deny sysctl-read kern.iossupportversion-extra" },
      { line: "deny sysctl-write kern.iossupportversion" },
    ])).toEqual([
      expect.objectContaining({ operation: "sysctl-read", target: "kern.iossupportversion-extra" }),
      expect.objectContaining({ operation: "sysctl-write", target: "kern.iossupportversion" }),
    ]);
  });

  it("keeps material SRT operations outside the legacy file/network allowlist", () => {
    expect(formatSandboxViolations([
      { line: "curl(11) deny(1) http-request https://api.example.invalid/v1" },
      { line: "worker(12) deny(1) openat /private/tmp/blocked" },
      { line: "worker(13) deny(1) mach-lookup com.apple.securityd" },
    ])).toBe([
      "Blocked by Sandlot: HTTP request https://api.example.invalid/v1",
      "Blocked by Sandlot: system call openat /private/tmp/blocked",
      "Blocked by Sandlot: Mach service lookup com.apple.securityd",
    ].join("\n"));
  });

  it("retains and safely formats a targetless material denial", () => {
    const formatted = formatSandboxViolations([{ line: "bash(42) deny(1) process-fork" }]);

    expect(formatted).toBe("Blocked by Sandlot: fork process");
    expect(formatted).not.toContain("<sandbox_violations>");
  });

  it("deduplicates wrapper/PID variants while retaining distinct targets", () => {
    expect(formatSandboxViolations([
      { line: "process pid=101 deny file-write /private/tmp/nope" },
      { line: "process pid=202 deny file-write /private/tmp/nope" },
      { line: "process pid=202 deny file-write /private/tmp/other" },
    ])).toBe(
      "Blocked by Sandlot: write file /private/tmp/nope\nBlocked by Sandlot: write file /private/tmp/other",
    );
  });

  it("deduplicates only proven aliases without merging distinct file-write operations", () => {
    expect(formatSandboxViolations([
      { line: "deny file-write /private/tmp/nope" },
      { line: "deny file-write-create /private/tmp/nope" },
      { line: "deny file-write-create /private/tmp/nope" },
      { line: "deny file-write-unlink /private/tmp/nope" },
      { line: "deny network example.invalid:443" },
      { line: "deny network-outbound example.invalid:443" },
      { line: "deny network-outbound other.invalid:443" },
    ])).toBe([
      "Blocked by Sandlot: write file /private/tmp/nope",
      "Blocked by Sandlot: create file /private/tmp/nope",
      "Blocked by Sandlot: remove file /private/tmp/nope",
      "Blocked by Sandlot: network access example.invalid:443",
      "Blocked by Sandlot: network access other.invalid:443",
    ].join("\n"));
  });

  it("removes terminal controls and XML-significant delimiters from generic notices", () => {
    const formatted = formatSandboxViolations([
      { line: "deny openat <sandbox_violations>&\u001b[31msecret\u0007" },
    ]);

    expect(formatted).toContain("Blocked by Sandlot: system call openat");
    expect(formatted).not.toMatch(/[\u0000-\u001f\u007f<>&]/);
    expect(formatted).not.toContain("<sandbox_violations>");
  });

  it("never exposes raw Runtime violation envelopes", () => {
    const formatted = formatSandboxViolations([{ line: "deny network-outbound example.invalid:443" }]);

    expect(formatted).toBe("Blocked by Sandlot: network access example.invalid:443");
    expect(formatted).not.toContain("<sandbox_violations>");
    expect(formatted).not.toContain("deny network-outbound");
  });

  it("formats Runtime's file-write-create operation as a material write denial", () => {
    expect(formatSandboxViolations([
      { line: "bash(42) deny(1) file-write-create /private/tmp/blocked" },
    ])).toBe("Blocked by Sandlot: create file /private/tmp/blocked");
  });
});
