import { afterEach, beforeEach, expect, it } from "vitest";
import { createSecurityHarness, type SecurityHarness } from "./harness.js";
import { describeIntegration } from "./preflight.js";

const CREDENTIALS = {
  SANDLOT_MASKED_INTEGRATION_TOKEN: "sandlot-real-integration-credential",
  CLAUDE_TMPDIR: "/private/tmp/sandlot-real-claude-tmpdir",
  CLAUDE_CODE_TMPDIR: "/private/tmp/sandlot-real-claude-code-tmpdir",
  JAVA_TOOL_OPTIONS: "-Dsandlot.secret=sandlot-real-java-options",
} as const;

describeIntegration("real isolated-service credential masking", () => {
  let harness: SecurityHarness | undefined;
  let previous: NodeJS.ProcessEnv;

  beforeEach(async () => {
    previous = Object.fromEntries(Object.keys(CREDENTIALS).map((name) => [name, process.env[name]]));
    Object.assign(process.env, CREDENTIALS);
    harness = await createSecurityHarness({ useProductionBoundary: true });
  });

  afterEach(async () => {
    await harness?.dispose();
    for (const name of Object.keys(CREDENTIALS)) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });

  it("shows a sentinel despite pass-through and injects the real value only at its allowed host", async () => {
    const host = new URL(harness!.credentialEchoUrl).hostname;
    const policy = {
      network: { allowedDomains: [host], allowLocalBinding: true },
      credentials: {
        allowPlaintextInject: true,
        envVars: Object.keys(CREDENTIALS).map((name) => ({
          name,
          mode: "mask" as const,
          injectHosts: [host],
        })),
      },
      environment: { passThrough: Object.keys(CREDENTIALS) },
    };

    const visible = await harness!.run(
      `printf '%s\\n' "$SANDLOT_MASKED_INTEGRATION_TOKEN" "$CLAUDE_TMPDIR" `
      + `"$CLAUDE_CODE_TMPDIR" "$JAVA_TOOL_OPTIONS"`,
      policy,
    );
    const injected = await harness!.run(
      `curl --fail --silent --show-error --max-time 5 --noproxy '' `
      + `-H "Authorization: Bearer $SANDLOT_MASKED_INTEGRATION_TOKEN" `
      + `-H "X-Claude-Tmpdir: $CLAUDE_TMPDIR" `
      + `-H "X-Claude-Code-Tmpdir: $CLAUDE_CODE_TMPDIR" `
      + `-H "X-Java-Tool-Options: $JAVA_TOOL_OPTIONS" `
      + `'${harness!.credentialEchoUrl}?all=1'`,
      policy,
    );

    expect(visible).toMatchObject({ exitCode: 0 });
    expect(visible.stdout.trim().split("\n")).toHaveLength(4);
    for (const visibleValue of visible.stdout.trim().split("\n")) expect(visibleValue).toMatch(/^fake_value_/);
    const injectedValues = JSON.parse(injected.stdout) as Record<string, string>;
    expect(injected).toMatchObject({ exitCode: 0 });
    expect(injectedValues).toEqual({
      authorization: `Bearer ${CREDENTIALS.SANDLOT_MASKED_INTEGRATION_TOKEN}`,
      claudeTmpdir: CREDENTIALS.CLAUDE_TMPDIR,
      claudeCodeTmpdir: CREDENTIALS.CLAUDE_CODE_TMPDIR,
      javaToolOptions: `${CREDENTIALS.JAVA_TOOL_OPTIONS} -Djava.net.preferIPv4Stack=true`,
    });
    for (const value of Object.values(CREDENTIALS)) {
      expect(visible.stdout).not.toContain(value);
      expect(injected.stderr).not.toContain(value);
    }
  });
});
