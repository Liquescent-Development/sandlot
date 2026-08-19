import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("security workflow release coverage", () => {
  it("keeps the current first-release workflow contract", async () => {
    const workflow = await readFile(
      new URL("../../.github/workflows/security.yml", import.meta.url),
      "utf8",
    );

    assertFirstReleaseWorkflow(workflow);
  });

  it("rejects representative omitted stages and alternate Ubuntu runners", async () => {
    const workflow = await readFile(
      new URL("../../.github/workflows/security.yml", import.meta.url),
      "utf8",
    );

    const accepted = [
      workflow.replace("run: npm test", "run: true"),
      workflow.replace("run: npm run typecheck", "run: true"),
      workflow.replace("run: npm run pack:check", "run: true"),
      workflow.replace("runs-on: macos-latest", "runs-on: macos-latest\n    runs-on: ubuntu-22.04"),
    ].map((mutant) => acceptsFirstReleaseWorkflow(mutant));

    expect(accepted).toEqual([false, false, false, false]);
  });

  function assertFirstReleaseWorkflow(workflow: string): void {
    const runners = [...workflow.matchAll(/^\s*runs-on:\s*(\S+)\s*$/gm)].map((match) => match[1]);
    expect(runners).toEqual(["macos-latest"]);
    expect(workflow).not.toContain("matrix:");
    expect(workflow).not.toContain("Install Linux sandbox prerequisites");
    expect(workflow).not.toContain("apt-get install");
    expect(workflow).toMatch(/push:\s*\n\s+branches:\s*\n\s+- main/);
    expect(workflow).toMatch(/pull_request:\s*\n/);
    expect(workflow).toMatch(/workflow_dispatch:\s*\n/);
    expect(workflow).toContain("Packed artifact, installed-enabled, and real Pi mode smoke tests");
    expect(workflow).toContain("Required Seatbelt filesystem/network/process real-sandbox integration tests");
    expect(workflow).toMatch(/SANDLOT_REQUIRE_INTEGRATION: "1"[\s\S]*run: npm run test:integration/);
    expect(workflow).not.toMatch(/continue-on-error:\s*true/);

    const stages = [
      "run: npm test",
      "run: npm run typecheck",
      "run: npm run build",
      "run: npm run test:smoke",
      "run: npm run test:integration",
      "run: npm run pack:check",
    ];
    const positions = stages.map((stage) => {
      const matches = [...workflow.matchAll(new RegExp(`^\\s*${escapeRegExp(stage)}\\s*$`, "gm"))];
      expect(matches).toHaveLength(1);
      return matches[0]!.index!;
    });
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  }

  function acceptsFirstReleaseWorkflow(workflow: string): boolean {
    try {
      assertFirstReleaseWorkflow(workflow);
      return true;
    } catch {
      return false;
    }
  }

  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
});
