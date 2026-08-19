import { access } from "node:fs/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { expectFileWorkerDenial } from "./assertions.js";
import {
  PROTECTED_TOOL_NAMES,
  createSecurityHarness,
  type SecurityHarness,
} from "./harness.js";
import { describeIntegration } from "./preflight.js";

describeIntegration("real Sandbox Runtime fail-closed integration", () => {
  let harness: SecurityHarness | undefined;

  beforeEach(async () => { harness = await createSecurityHarness(); });
  afterEach(async () => { await harness?.dispose(); });

  it("blocks every protected tool after a real initialization failure without local fallback", async () => {
    await harness!.failInitialization();
    expect(harness!.runtimeState()).toBe("failed");

    for (const name of PROTECTED_TOOL_NAMES) {
      await expect(harness!.invokeProtectedTool(name)).rejects.toThrow(/runtime is not ready \(failed\)/);
    }
    expect(harness!.localFallbackCalls).toEqual([]);
  });

  it("checks live ownership and blocks a protected tool replaced after readiness", async () => {
    expect(harness!.guardToolCall("bash")).toBeUndefined();

    await harness!.replaceProtectedTool("bash");

    expect(harness!.guardToolCall("bash")).toMatchObject({
      block: true,
      reason: expect.stringMatching(/ownership check failed/i),
    });
    expect(harness!.localFallbackCalls).toEqual([]);
  });

  it("never invokes a local fallback after a real sandbox denial", async () => {
    const escaped = `${harness!.outside}/no-fallback.txt`;
    await expectFileWorkerDenial(
      harness!.invokeProtectedTool("write", { path: escaped, content: "escape" }),
      escaped,
      "write",
    );

    await expect(access(escaped)).rejects.toThrow();
    expect(harness!.localFallbackCalls).toEqual([]);
  });
});
