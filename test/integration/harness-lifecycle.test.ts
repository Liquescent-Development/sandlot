import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";
import { expect, it } from "vitest";
import {
  createSecurityHarness,
  type SecurityHarnessOptions,
} from "./harness.js";
import { describeIntegration } from "./preflight.js";

describeIntegration("real security harness setup cleanup", () => {
  it("does not race workspace creation against recursive protected fixture paths", async () => {
    let observedRoot: string | undefined;
    const harness = await createSecurityHarness({
      async setupCheckpoint(stage, state) {
        if (stage !== "root-created") return;
        observedRoot = state.root;
        await mkdir(join(state.root, "workspace"));
      },
    });

    await harness.dispose();
    expect(observedRoot).toBeTypeOf("string");
    await expect(access(observedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the exact partial root when setup fails immediately after creation", async () => {
    let observedRoot: string | undefined;
    const attempt = expectInjectedSetupFailure({
      async setupCheckpoint(stage, state) {
        if (stage !== "root-created") return;
        observedRoot = state.root;
        await mkdir(join(state.root, "partial-fixture"));
        throw new Error("injected partial-fixture setup failure");
      },
    });

    await expect(attempt).rejects.toThrow("injected partial-fixture setup failure");
    expect(observedRoot).toBeTypeOf("string");
    await expect(access(observedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("closes the real loopback server and removes its root when later setup fails", async () => {
    let observedRoot: string | undefined;
    let observedPort: number | undefined;
    const attempt = expectInjectedSetupFailure({
      setupCheckpoint(stage, state) {
        if (stage !== "server-listening") return;
        observedRoot = state.root;
        observedPort = state.port;
        throw new Error("injected listening-server setup failure");
      },
    });

    await expect(attempt).rejects.toThrow("injected listening-server setup failure");
    expect(observedRoot).toBeTypeOf("string");
    expect(observedPort).toBeTypeOf("number");
    await expect(access(observedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
    await expectPortClosed(observedPort!);
  });
});

async function expectInjectedSetupFailure(options: SecurityHarnessOptions): Promise<void> {
  const unexpectedHarness = await createSecurityHarness(options);
  await unexpectedHarness.dispose();
  throw new Error("security harness ignored the injected setup failure");
}

async function expectPortClosed(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`port ${port} remained indeterminate after failed setup`));
    }, 1_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`port ${port} remained open after failed setup`));
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
