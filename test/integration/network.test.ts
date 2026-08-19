import { afterEach, beforeEach, expect, it } from "vitest";
import { createServer as createUnixServer } from "node:net";
import { createSecurityHarness, type SecurityHarness } from "./harness.js";
import { describeIntegration } from "./preflight.js";

describeIntegration("real Sandbox Runtime network enforcement", () => {
  let harness: SecurityHarness | undefined;

  beforeEach(async () => { harness = await createSecurityHarness(); });
  afterEach(async () => { await harness?.dispose(); });

  it("denies the loopback HTTP fixture under an empty allowlist", async () => {
    const result = await harness!.run(curl(harness!.allowedUrl));

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("allowed");
  });

  it("permits only the explicitly allowlisted loopback HTTP fixture", async () => {
    const result = await harness!.run(curl(harness!.allowedUrl), {
      network: { allowedDomains: [new URL(harness!.allowedUrl).hostname] },
    });

    expect(result).toMatchObject({ exitCode: 0, stdout: "allowed" });
  });

  it("attributes a real proxy denial to its command ID and not a harmless command", async () => {
    const denied = await harness!.runWithId(curl(harness!.allowedUrl), "network-denied");
    const harmless = await harness!.runWithId("printf harmless", "network-harmless");
    const destination = new URL(harness!.allowedUrl).host;
    const deniedViolations = harness!.violationsFor("network-denied");
    const harmlessViolations = harness!.violationsFor("network-harmless");

    expect(denied.exitCode).not.toBe(0);
    expect(deniedViolations).toEqual(expect.arrayContaining([
      expect.stringContaining(`network-outbound ${destination}`),
    ]));
    expect(harmlessViolations.some((line) => line.includes(`network-outbound ${destination}`))).toBe(false);
    expect(denied.stderr).toContain(destination);
    expect(harmless).toMatchObject({ exitCode: 0, stdout: "harmless" });
  });

  it("tears down real proxy resources and never carries violations into a disposed session", async () => {
    await harness!.runWithId(curl(harness!.allowedUrl), "disposed-denial");
    expect(harness!.violationsFor("disposed-denial").length).toBeGreaterThan(0);
    const oldPorts = [...harness!.resourcePorts];

    await harness!.dispose();
    for (const port of oldPorts) await expectPortClosed(port);

    harness = await createSecurityHarness();
    const current = await harness.runWithId("printf current-session", "disposed-denial");
    expect(current).toMatchObject({ exitCode: 0, stdout: "current-session" });
    expect(harness.violationsFor("disposed-denial").some((line) => line.includes("network-outbound"))).toBe(false);
  });

  it.runIf(process.platform === "linux")("denies a real AF_UNIX connection under the default seccomp policy", async () => {
    const socketPath = `${harness!.outside}/denied.sock`;
    let connected = false;
    const server = createUnixServer(() => { connected = true; });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      const script = [
        'const { connect } = require("node:net");',
        `const socket = connect(${JSON.stringify(socketPath)});`,
        "socket.once('connect', () => process.exit(0));",
        "socket.once('error', () => process.exit(41));",
        "setTimeout(() => process.exit(42), 2000);",
      ].join("");
      const result = await harness!.run(`${quote(process.execPath)} -e ${quote(script)}`);

      expect(result.exitCode).not.toBe(0);
      expect(connected).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });
});

function curl(url: string): string {
  return `curl --fail --silent --show-error --max-time 5 --noproxy '' '${url}'`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function expectPortClosed(port: number): Promise<void> {
  const { connect } = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`port ${port} remained indeterminate after teardown`));
    }, 1_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`port ${port} remained open after teardown`));
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
