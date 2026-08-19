import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("executes metadata staging with the macOS system Bash interface", async () => {
    // Bash-4-only descriptor allocation would make the supported macOS verify job fail before validation.
    const workflow = await readFile(WORKFLOW_URL, "utf8");
    const runnerTemp = await mkdtemp(join(tmpdir(), "sandlot-release-workflow-"));
    try {
      const result = spawnSync("/bin/bash", ["-c", stepScript(workflow, "Generate validated release metadata")], {
        cwd: new URL("../..", import.meta.url),
        encoding: "utf8",
        env: { ...process.env, RUNNER_TEMP: runnerTemp, RELEASE_VERSION: "0.1.0" },
      });
      expect(result.status, result.stderr).toBe(0);
      const metadataRoot = join(runnerTemp, "sandlot-release", "metadata");
      expect(JSON.parse(await readFile(join(metadataRoot, "release-metadata.json"), "utf8"))).toEqual({
        version: "0.1.0",
        tag: "v0.1.0",
        notesFile: "release-notes.md",
      });
      expect((await stat(join(metadataRoot, "release-notes.md"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(metadataRoot, "release-metadata.json"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(runnerTemp, { recursive: true, force: true });
    }
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

  it("rejects additive triggers, permissions, and pinned actions", async () => {
    // Additive authority must fail even when every originally required value remains present.
    const workflow = await readFile(WORKFLOW_URL, "utf8");
    const mutants = [
      workflow.replace("        type: string\n\npermissions:", "        type: string\n  schedule:\n    - cron: '0 0 * * *'\n\npermissions:"),
      workflow.replace("permissions:\n  contents: read", "permissions:\n  contents: read\n  id-token: write"),
      workflow.replace("    timeout-minutes: 45\n", "    timeout-minutes: 45\n    permissions:\n      id-token: write\n"),
      workflow.replace("    permissions:\n      contents: write", "    permissions:\n      contents: write\n      id-token: write"),
      workflow.replace("    steps:\n      - name: Download verified handoff", "    steps:\n      - name: Unreviewed pinned action\n        uses: actions/cache@6849a6489940f00c2f30c0fb92c6274307ccb58a\n\n      - name: Download verified handoff"),
    ];
    expect(mutants.every((mutant) => mutant !== workflow)).toBe(true);
    expect(mutants.map(acceptsReleaseWorkflow)).toEqual([false, false, false, false, false]);
  });

  it("reports the intended tag and returned ID when draft creation returns malformed state", async () => {
    // Validating before retaining a returned ID would strand a created draft without actionable recovery output.
    const workflow = await readFile(WORKFLOW_URL, "utf8");
    const root = await mkdtemp(join(tmpdir(), "sandlot-release-publish-"));
    const commit = "a".repeat(40);
    const version = "0.1.0";
    const tag = `v${version}`;
    const tarballName = `sandlot-${version}.tgz`;
    const checksumName = `${tarballName}.sha256`;
    const tarball = Buffer.from("verified tarball\n", "utf8");
    const digest = createHash("sha256").update(tarball).digest("hex");
    const diagnostics: string[] = [];
    try {
      await Promise.all([
        mkdir(join(root, "artifact"), { mode: 0o700 }),
        mkdir(join(root, "metadata"), { mode: 0o700 }),
      ]);
      await Promise.all([
        writeFile(join(root, "artifact", "release-handoff.json"), JSON.stringify({
          version, tag, commit, tarball: tarballName, checksum: checksumName,
          tarballBytes: tarball.length, sha256: digest,
        })),
        writeFile(join(root, "artifact", tarballName), tarball),
        writeFile(join(root, "artifact", checksumName), `${digest}  ${tarballName}\n`),
        writeFile(join(root, "metadata", "release-metadata.json"), JSON.stringify({
          version, tag, notesFile: "release-notes.md",
        })),
        writeFile(join(root, "metadata", "release-notes.md"), "Release notes.\n"),
      ]);

      const github = {
        paginate: async () => [],
        request: async (route: string) => {
          if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
            if (!githubMainReturned) {
              githubMainReturned = true;
              return { data: { object: { type: "commit", sha: commit } } };
            }
            throw Object.assign(new Error("not found"), { status: 404 });
          }
          if (route === "POST /repos/{owner}/{repo}/releases") {
            return { data: { id: 71, draft: true, tag_name: "malformed-tag" } };
          }
          throw new Error(`unexpected request: ${route}`);
        },
      };
      let githubMainReturned = false;
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const execute = new AsyncFunction("require", "process", "context", "github", "core", stepJavascript(workflow, "Publish verified immutable release"));

      await expect(execute(
        createRequire(import.meta.url),
        { env: { HANDOFF_ROOT: root } },
        { repo: { owner: "Liquescent-Development", repo: "sandlot" } },
        github,
        { error: (message: string) => diagnostics.push(message) },
      )).rejects.toThrow("GitHub returned an invalid draft release");
      expect(diagnostics).toEqual([
        expect.stringContaining("71"),
      ]);
      expect(diagnostics[0]).toContain(tag);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function assertReleaseWorkflow(workflow: string): void {
  const triggerStart = workflow.indexOf("\non:\n") + 1;
  const permissionsStart = workflow.indexOf("\npermissions:\n", triggerStart);
  expect(triggerStart).toBeGreaterThan(0);
  expect(permissionsStart).toBeGreaterThan(triggerStart);
  expect(workflow.slice(triggerStart, permissionsStart)).toMatch(
    /^on:\n  workflow_dispatch:\n    inputs:\n      version:\n        description: [^\n]+\n        required: true\n        type: string\n$/,
  );
  expect(workflow).not.toMatch(/^\s*(?:push|pull_request):/m);
  expect(workflow).not.toContain("continue-on-error:");
  expect(workflow).not.toMatch(/(?:force|--force).*(?:tag|refs\/tags)|npm publish/i);
  const concurrencyStart = workflow.indexOf("\nconcurrency:\n", permissionsStart);
  expect(workflow.slice(permissionsStart + 1, concurrencyStart)).toBe("permissions:\n  contents: read\n");
  expect(workflow.match(/^permissions:/gm)).toHaveLength(1);
  expect(workflow).toMatch(/concurrency:\n  group: release-\$\{\{ github\.repository \}\}\n  cancel-in-progress: false/);

  const verify = jobBody(workflow, "verify", "publish");
  expect(verify).toContain("runs-on: macos-latest");
  expect(verify).toContain("if: github.ref == 'refs/heads/main'");
  expect(verify).toContain("RELEASE_VERSION: ${{ inputs.version }}");
  expect(verify).not.toContain("contents: write");
  expect(verify).not.toMatch(/^    permissions:/m);
  expect(verify).toContain("fetch-depth: 0");
  expect(verify).toContain("node-version: 22.19.0");
  expect(verify).toContain("brew install ripgrep");
  expect(verify).toContain("run: npm ci");
  expect(verify).toContain("--notes-fd 8");
  expect(verify).toContain("--metadata-fd 9");
  expect(verify).toContain("--notes-file release-notes.md");
  expect(verify).toContain('exec 8<>"$notes_path"');
  expect(verify).toContain('exec 9<>"$metadata_path"');
  expect(verify).toContain("exec 8>&-");
  expect(verify).toContain("exec 9>&-");
  expect(verify).not.toMatch(/exec \{[^}]+\}/);
  expect(verify).toContain("chmod 600");
  expect(verify).toContain("npm run release:verify");
  expect(verify).toContain("git diff --exit-code");
  expect(verify).toContain("git status --porcelain");
  expect(verify).toContain("retention-days: 1");
  expect(verify).toContain("if-no-files-found: error");

  const publish = jobBody(workflow, "publish");
  expect(publish).toContain("needs: verify");
  expect(publish).toContain("contents: write");
  expect(publish).toMatch(/\n    permissions:\n      contents: write\n\n    steps:\n/);
  expect(publish.match(/^    permissions:/gm)).toHaveLength(1);
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
  expect(actionsIn(verify)).toEqual([pins[0], pins[1], pins[4], pins[2]]);
  expect(actionsIn(publish)).toEqual([pins[3], pins[4]]);

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

function actionsIn(block: string): string[] {
  return [...block.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)].map((match) => match[1]!);
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

function stepScript(workflow: string, name: string): string {
  const stepStart = workflow.indexOf(`      - name: ${name}\n`);
  expect(stepStart).toBeGreaterThan(-1);
  const runStart = workflow.indexOf("        run: |\n", stepStart);
  expect(runStart).toBeGreaterThan(stepStart);
  const bodyStart = runStart + "        run: |\n".length;
  const nextStep = workflow.indexOf("\n      - name:", bodyStart);
  const body = workflow.slice(bodyStart, nextStep === -1 ? workflow.length : nextStep);
  return `${body.split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n")}\n`;
}

function stepJavascript(workflow: string, name: string): string {
  const stepStart = workflow.indexOf(`      - name: ${name}\n`);
  expect(stepStart).toBeGreaterThan(-1);
  const scriptStart = workflow.indexOf("          script: |\n", stepStart);
  expect(scriptStart).toBeGreaterThan(stepStart);
  const bodyStart = scriptStart + "          script: |\n".length;
  const nextStep = workflow.indexOf("\n      - name:", bodyStart);
  const body = workflow.slice(bodyStart, nextStep === -1 ? workflow.length : nextStep);
  return `${body.split("\n").map((line) => line.startsWith("            ") ? line.slice(12) : line).join("\n")}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
