import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const WORKFLOW_URL = new URL("../../.github/workflows/release.yml", import.meta.url);

const pins = [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
] as const;

const orderedStages = [
  "name: Generate validated release metadata",
  "name: Read-only remote preflight",
  "name: Verify release tree",
  "name: Build verified release artifact",
  "name: Upload verified handoff",
  "name: Download verified handoff",
  "await authoritativeRemoteRecheck();",
  "draft = await createDraftRelease();",
  "await uploadAndVerifyReleaseAssets();",
  "await publishDraftRelease();",
  "await assertImmutablePublicRelease();",
] as const;

describe("stable release workflow", () => {
  it("keeps release verification separate from least-privilege publication", async () => {
    const workflow = await readFile(WORKFLOW_URL, "utf8");
    assertReleaseWorkflow(workflow);
  });

  it("rejects omitted or reordered release stages", async () => {
    const workflow = await readFile(WORKFLOW_URL, "utf8");
    const removed = orderedStages.map((stage, index) => workflow.replace(stage, `removed-release-stage-${index}`));
    const reordered = orderedStages.slice(0, -1).map((stage, index) => {
      const following = orderedStages[index + 1]!;
      return workflow.replace(stage, "__EARLIER__").replace(following, stage).replace("__EARLIER__", following);
    });

    expect([...removed, ...reordered].every((mutant) => !acceptsReleaseWorkflow(mutant))).toBe(true);
  });

  it("rejects privilege, trigger, action-pin, and input-interpolation regressions", async () => {
    const workflow = await readFile(WORKFLOW_URL, "utf8");
    const publishAt = workflow.indexOf("\n  publish:");
    const mutants = [
      `${workflow.slice(0, publishAt)}${workflow.slice(publishAt).replace("steps:\n", `steps:\n      - uses: ${pins[0]}\n`)}`,
      workflow.replace("permissions:\n  contents: read", "permissions:\n  contents: write"),
      workflow.replace("on:\n  workflow_dispatch:", "on:\n  push:\n    branches: [main]\n  workflow_dispatch:"),
      workflow.replace("on:\n  workflow_dispatch:", "on:\n  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:"),
      workflow.replace(pins[0], "actions/checkout@main"),
      workflow.replace("run: npm ci", "run: npm ci ${{ inputs.version }}"),
      workflow.replace("await assertImmutablePublicRelease();", "await Promise.resolve();"),
    ];

    expect(mutants.every((mutant) => !acceptsReleaseWorkflow(mutant))).toBe(true);
  });
});

function assertReleaseWorkflow(workflow: string): void {
  expect(workflow).toMatch(/^name: Stable release\n\non:\n  workflow_dispatch:\n    inputs:\n      version:\n        description: .+\n        required: true\n        type: string\n/m);
  expect(workflow).not.toMatch(/^\s*(?:push|pull_request):/m);
  expect(workflow).not.toContain("continue-on-error:");
  expect(workflow).not.toMatch(/(?:force|--force).*(?:tag|refs\/tags)|npm publish/i);
  expect(workflow).toContain("permissions:\n  contents: read");
  expect(workflow.match(/^permissions:/gm)).toHaveLength(1);
  expect(workflow).toMatch(/concurrency:\n  group: release-\$\{\{ github\.repository \}\}\n  cancel-in-progress: false/);

  const verify = jobBody(workflow, "verify", "publish");
  expect(verify).toContain("runs-on: macos-latest");
  expect(verify).toContain("if: github.ref == 'refs/heads/main'");
  expect(verify).toContain("RELEASE_VERSION: ${{ inputs.version }}");
  expect(verify).not.toContain("contents: write");
  expect(verify).toContain("fetch-depth: 0");
  expect(verify).toContain("node-version: 22.19.0");
  expect(verify).toContain("brew install ripgrep");
  expect(verify).toContain("run: npm ci");
  expect(verify).toContain("--notes-fd \"$notes_fd\"");
  expect(verify).toContain("--metadata-fd \"$metadata_fd\"");
  expect(verify).toContain("--notes-file release-notes.md");
  expect(verify).toContain("exec {notes_fd}<>");
  expect(verify).toContain("exec {metadata_fd}<>");
  expect(verify).toContain("chmod 600");
  expect(verify).toContain("npm run release:verify");
  expect(verify).toContain("git diff --exit-code");
  expect(verify).toContain("git status --porcelain");
  expect(verify).toContain("retention-days: 1");
  expect(verify).toContain("if-no-files-found: error");

  const publish = jobBody(workflow, "publish");
  expect(publish).toContain("needs: verify");
  expect(publish).toContain("contents: write");
  expect(publish).toContain("name: verified-release-handoff");
  expect(publish).not.toContain("actions/checkout@");
  expect(publish).not.toMatch(/^\s*run:/m);
  expect(publish).not.toMatch(/npm (?:ci|run)|node scripts\//);
  expect(publish).not.toContain("RELEASE_VERSION");
  expect(publish).toContain("github-token: ${{ secrets.GITHUB_TOKEN }}");
  expect(publish).toContain('const API_VERSION = "2026-03-10";');
  expect(publish).toContain("immutable !== true");
  expect(publish).toContain("if (seen.has(asset.name))");
  expect(publish).toContain("seen.add(asset.name);");
  expect(publish).not.toMatch(/deleteRelease|deleteRef|updateRef|createRef/);

  for (const pin of pins) expect(workflow).toContain(pin);
  const usedActions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)].map((match) => match[1]);
  expect(usedActions.length).toBeGreaterThanOrEqual(pins.length);
  expect(usedActions.every((action) => /@[0-9a-f]{40}$/.test(action))).toBe(true);

  const positions = orderedStages.map((stage) => {
    const matches = [...workflow.matchAll(new RegExp(escapeRegExp(stage), "g"))];
    expect(matches).toHaveLength(1);
    return matches[0]!.index!;
  });
  expect(positions).toEqual([...positions].sort((left, right) => left - right));

  const inputExpressions = workflow.split("\n").filter((line) => line.includes("${{ inputs.version }}"));
  expect(inputExpressions.map((line) => line.trim())).toEqual(["RELEASE_VERSION: ${{ inputs.version }}"]);
  expect(workflow.slice(0, workflow.indexOf("\njobs:")).includes("\nenv:")).toBe(false);
}

function acceptsReleaseWorkflow(workflow: string): boolean {
  try {
    assertReleaseWorkflow(workflow);
    return true;
  } catch {
    return false;
  }
}

function jobBody(workflow: string, job: string, nextJob?: string): string {
  const start = workflow.indexOf(`\n  ${job}:`);
  expect(start).toBeGreaterThan(-1);
  const end = nextJob === undefined ? workflow.length : workflow.indexOf(`\n  ${nextJob}:`, start + 1);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
