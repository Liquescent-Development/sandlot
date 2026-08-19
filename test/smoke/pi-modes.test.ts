import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sep } from "node:path";
import {
  assertCleanModeExit,
  combinedOutput,
  installPackedArtifact,
  parseJsonLines,
  PROJECT_ROOT,
  piArgs,
  run,
  runInteractivePty,
  runRpc,
  type CommandResult,
  type SmokeInstallation,
  writeUserPolicy,
} from "./harness.js";

const supported = process.platform === "darwin" || process.platform === "linux";

describe.skipIf(!supported)("packed extension in real Pi 0.84.2 modes", () => {
  let installation: SmokeInstallation;

  beforeAll(async () => {
    installation = await installPackedArtifact();
  }, 150_000);

  afterAll(async () => installation?.cleanup());

  it("auto-activates the installed tarball in print, JSON, and RPC diagnostic commands", async () => {
    expect(installation.runtimeDependencyPaths).toHaveLength(5);
    for (const path of installation.runtimeDependencyPaths) {
      expect(path.startsWith(`${installation.root}${sep}`), `${path} escaped the smoke fixture`).toBe(true);
      expect(path.startsWith(`${PROJECT_ROOT}${sep}`), `${path} resolves into the checkout`).toBe(false);
    }
    await writeUserPolicy(installation, '{"enabled":false}\n');
    const print = await run(process.execPath, piArgs("--print", "/sandlot"), {
        cwd: installation.workspace,
        env: installation.env,
      });
    const json = await run(process.execPath, piArgs("--mode", "json", "/sandlot"), {
        cwd: installation.workspace,
        env: installation.env,
      });
    const rpc = await runRpc(installation);

    for (const [mode, result] of [["print", print], ["json", json], ["rpc", rpc]] as const) {
      assertCleanModeExit(result, mode);
    }
    expect(print.stdout).toBe("");
    expect(print.stderr).toContain("Sandlot diagnostics");
    expect(print.stderr).toContain("state: disabled-by-user");
    expectSessionRecord(parseJsonLines(json.stdout, "JSON stdout"));
    expect(json.stderr).toContain("Sandlot diagnostics");
    expect(json.stderr).toContain("state: disabled-by-user");
    expect(rpc.stderr).toBe("");
    const rpcRecords = parseJsonLines(rpc.stdout, "RPC stdout");
    expect(rpcRecords).toContainEqual({
      id: "sandlot-smoke",
      type: "response",
      command: "prompt",
      success: true,
    });
    expect(rpcRecords).toContainEqual(expect.objectContaining({
      type: "extension_ui_request",
      method: "setStatus",
      statusKey: "sandlot",
      statusText: "🔓 Sandlot disabled",
    }));
    expect(rpcRecords).toContainEqual(expect.objectContaining({
      type: "extension_ui_request",
      method: "notify",
      notifyType: "warning",
      message: expect.stringContaining("disabled by trusted user policy"),
    }));
    expect(rpcRecords).toContainEqual(expect.objectContaining({
      type: "extension_ui_request",
      method: "notify",
      notifyType: "info",
      message: expect.stringContaining("state: disabled-by-user"),
    }));
  }, 90_000);

  it("shows Sandlot status after interactive PTY startup from the installed tarball", async () => {
    await writeUserPolicy(installation, '{"enabled":false}\n');
    const result = await runInteractivePty(installation);
    assertCleanModeExit(result, "interactive PTY");
    const output = combinedOutput(result);
    const status = output.indexOf("Sandlot disabled");
    const diagnostic = output.indexOf("Sandlot diagnostics");
    expect(status).toBeGreaterThanOrEqual(0);
    expect(diagnostic).toBeGreaterThan(status);
  }, 60_000);

  it("fails closed with visible diagnostics in every noninteractive mode", async () => {
    await writeUserPolicy(installation, '{"enabled":"not-a-boolean"}\n');
    const print = await run(process.execPath, piArgs("--print", "/sandlot"), {
        cwd: installation.workspace,
        env: installation.env,
      });
    const json = await run(process.execPath, piArgs("--mode", "json", "/sandlot"), {
        cwd: installation.workspace,
        env: installation.env,
      });
    const rpc = await runRpc(installation);

    for (const [mode, result] of [["print", print], ["json", json], ["rpc", rpc]] as const) {
      assertCleanModeExit(result, mode);
    }
    expect(print.stdout).toBe("");
    expect(print.stderr).toMatch(/Sandlot configuration error[\s\S]*enabled/i);
    expect(print.stderr).toContain("state: failed");
    expectSessionRecord(parseJsonLines(json.stdout, "invalid-policy JSON stdout"));
    expect(json.stderr).toMatch(/Sandlot configuration error[\s\S]*enabled/i);
    expect(json.stderr).toContain("state: failed");
    expect(rpc.stderr).toBe("");
    const rpcRecords = parseJsonLines(rpc.stdout, "invalid-policy RPC stdout");
    expect(rpcRecords).toContainEqual({
      id: "sandlot-smoke",
      type: "response",
      command: "prompt",
      success: true,
    });
    expect(rpcRecords).toContainEqual(expect.objectContaining({
      type: "extension_ui_request",
      method: "setStatus",
      statusKey: "sandlot",
      statusText: "⚠ Sandlot failed",
    }));
    expect(rpcRecords).toContainEqual(expect.objectContaining({
      type: "extension_ui_request",
      method: "notify",
      notifyType: "error",
      message: expect.stringMatching(/Sandlot configuration error[\s\S]*enabled/i),
    }));
    expect(rpcRecords).toContainEqual(expect.objectContaining({
      type: "extension_ui_request",
      method: "notify",
      notifyType: "info",
      message: expect.stringContaining("state: failed"),
    }));
  }, 90_000);
});

function expectSessionRecord(records: unknown[]): void {
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ type: "session", version: 3 });
  expect(records[0]).toEqual(expect.objectContaining({
    id: expect.any(String),
    timestamp: expect.any(String),
    cwd: expect.any(String),
  }));
}
