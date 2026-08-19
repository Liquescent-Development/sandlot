import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SandboxRunner, type SandboxManagerLike } from "../../src/runner.js";
import { RuntimeController } from "../../src/runtime.js";
import { describeIntegration } from "./preflight.js";

describeIntegration("macOS detached descendant supervision", () => {
  it.runIf(process.platform === "darwin")(
    "kills a new-session Node descendant and waits for its heartbeat to stop",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "sandlot-descendants-"));
      const childScript = join(root, "child.mjs");
      const parentScript = join(root, "parent.mjs");
      const heartbeat = join(root, "heartbeat");
      try {
        await writeFile(childScript, [
          'import { appendFileSync } from "node:fs";',
          "const target = process.argv[2];",
          'setInterval(() => appendFileSync(target, "."), 10);',
        ].join("\n"));
        await writeFile(parentScript, [
          'import { spawn } from "node:child_process";',
          'const child = spawn(process.execPath, [process.argv[2], process.argv[3]], { detached: true, stdio: "ignore" });',
          "child.unref();",
          "await new Promise((resolve) => setTimeout(resolve, 250));",
        ].join("\n"));
        const manager = {
          wrapWithSandboxArgv: vi.fn(async () => ({
            argv: [process.execPath, parentScript, childScript, heartbeat],
            env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", TMPDIR: "/private/tmp" },
          })),
          cleanupAfterCommand: vi.fn(),
          getSandboxViolationStore: vi.fn(() => ({ getViolationsForCommand: () => [] })),
        } satisfies SandboxManagerLike;
        const runtime = new RuntimeController();
        runtime.beginInitialization();
        runtime.markReady({} as never);
        const runner = new SandboxRunner(manager, runtime);

        await expect(runner.run({
          invocationId: "detached-real",
          command: "probe",
          commandText: "probe",
          cwd: root,
          env: {},
          timeoutMs: 5_000,
        })).resolves.toMatchObject({ exitCode: 0 });

        const sizeAtReturn = (await stat(heartbeat)).size;
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect((await readFile(heartbeat)).length).toBe(sizeAtReturn);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
