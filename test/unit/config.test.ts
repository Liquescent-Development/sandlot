import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { SandlotConfigError, loadPolicyFiles, parseProjectPolicy, parseUserPolicy, secureUserDefaults } from "../../src/config.js";

describe("Sandlot configuration", () => {
  it("rejects unknown security keys", () => {
    expect(() => parseUserPolicy({ network: { allowedDomain: ["example.com"] } }))
      .toThrow(/allowedDomain/);
  });

  it("rejects trusted-only project keys", () => {
    expect(() => parseProjectPolicy({ enabled: false })).toThrow(/enabled/);
    expect(() => parseProjectPolicy({ environment: { passThrough: ["TOKEN"] } })).toThrow(/environment/);
    expect(() => parseProjectPolicy({
      credentials: { files: [{ path: "/tmp/project-secret", mode: "deny" }] },
    })).toThrow(/credentials/);
  });

  it("accepts the curated trusted-user policy surface", () => {
    expect(parseUserPolicy({
      enabled: true,
      network: {
        allowedDomains: ["api.example.com"],
        deniedDomains: ["blocked.example.com"],
        deniedDomainReasons: { "blocked.example.com": "blocked by user" },
        allowUnixSockets: ["/tmp/service.sock"],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
        tlsTerminate: { excludeDomains: ["public.example.com"] },
      },
      filesystem: { denyRead: ["/secret"], allowRead: ["/work"], allowWrite: ["/work"], denyWrite: ["/work/.env"] },
      credentials: { envVars: [{ name: "EXAMPLE_TOKEN", mode: "deny" }] },
      environment: { passThrough: ["SAFE_FLAG"], deny: ["EXAMPLE_TOKEN"], exposePiSessionMetadata: false },
      trustedCustomTools: ["safe-tool"],
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
      ripgrep: { command: "/usr/bin/rg" },
      seccomp: { applyPath: "/usr/local/bin/apply-seccomp" },
      bwrapPath: "/usr/bin/bwrap",
      socatPath: "/usr/bin/socat",
    })).toMatchObject({ network: { allowedDomains: ["api.example.com"] } });
  });

  it("rejects removed inert diagnostics disclosure options", () => {
    expect(() => parseUserPolicy({ diagnostics: { enabled: true } }))
      .toThrow(/diagnostics|unrecognized/i);
  });

  it("rejects uncurated nested user-policy keys and invalid environment names", () => {
    expect(() => parseUserPolicy({ network: { parentProxy: { http: "http://proxy" } } }))
      .toThrow(/parentProxy/);
    expect(() => parseUserPolicy({ environment: { passThrough: ["NOT-AN-ENV-NAME"] } }))
      .toThrow(/environment variable/);
  });

  it.each([
    { ripgrep: { command: "/usr/bin/rg", args: ["--hidden"] } },
    { ripgrep: { command: "/usr/bin/rg", argv0: "rg" } },
  ])("rejects unsupported ripgrep argument decoration instead of dropping it", (policy) => {
    expect(() => parseUserPolicy(policy)).toThrow(/ripgrep\.(args|argv0)|unrecognized/i);
  });

  it("rejects strictAllowlist and removed policy settings", () => {
    expect(() => parseUserPolicy({ network: { strictAllowlist: false } })).toThrow(/strictAllowlist/);
    expect(() => parseUserPolicy({ allowPty: false })).toThrow(/allowPty/);
    expect(() => parseUserPolicy({ ignoreViolations: {} })).toThrow(/ignoreViolations/);
    expect(() => parseProjectPolicy({ allowPty: false })).toThrow(/allowPty/);
  });

  it("uses Sandbox Runtime validation for network and credential declarations", () => {
    expect(() => parseUserPolicy({ network: { allowedDomains: ["https://api.example.com"] } }))
      .toThrow(/Invalid domain pattern/);
    expect(() => parseUserPolicy({ network: { tlsTerminate: { caCertPath: "/cert.pem" } } }))
      .toThrow(/caCertPath and caKeyPath/);
    expect(() => parseUserPolicy({
      credentials: { envVars: [{ name: "TOKEN", mode: "mask", maskClaims: [] }] },
      network: { tlsTerminate: {} },
    })).toThrow(/maskClaims/);
    expect(() => parseUserPolicy({
      credentials: { awsPairs: [{ accessKeyIdVar: "AWS_ID", secretAccessKeyVar: "AWS_SECRET" }] },
      network: { tlsTerminate: {} },
    })).toThrow(/AWS_ID/);
    expect(() => parseUserPolicy({ credentials: { envVars: [{ name: "TOKEN", mode: "mask" }] } }))
      .toThrow(/Credential masking requires network\.tlsTerminate/);
  });

  it("accepts only project-side reductions", () => {
    expect(parseProjectPolicy({
      network: { allowedDomains: ["api.example.com"], deniedDomains: ["blocked.example.com"], allowUnixSockets: [] },
      filesystem: { allowWrite: ["/work/subdir"], denyWrite: ["/work/subdir/.env"] },
      trustedCustomTools: [],
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
    })).toMatchObject({ filesystem: { allowWrite: ["/work/subdir"] } });
    expect(() => parseProjectPolicy({ network: { allowedDomains: ["https://api.example.com"] } }))
      .toThrow(/Invalid domain pattern/);
  });

  it("does not read project policy for an untrusted project", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-config-"));
    await mkdir(join(root, CONFIG_DIR_NAME));
    await writeFile(join(root, CONFIG_DIR_NAME, "sandlot.json"), "not-json");
    await expect(loadPolicyFiles({ cwd: root, agentDir: join(root, "agent"), projectTrusted: false }))
      .resolves.toMatchObject({ project: undefined });
  });

  it("treats missing files as absent but trusted invalid files as errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-config-"));
    const agentDir = join(root, "agent");
    await expect(loadPolicyFiles({ cwd: root, agentDir, projectTrusted: true }))
      .resolves.toEqual({ user: undefined, project: undefined });

    await mkdir(agentDir);
    await writeFile(join(agentDir, "sandlot.json"), "not-json");
    await expect(loadPolicyFiles({ cwd: root, agentDir, projectTrusted: true }))
      .rejects.toThrow(/Sandlot configuration error in .*agent.*sandlot\.json/);
  });

  it("reports user file read failures with their source and cause", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-config-"));
    const agentDir = join(root, "agent");
    const policyPath = join(agentDir, "sandlot.json");
    await mkdir(policyPath, { recursive: true });

    const error = await loadPolicyFiles({ cwd: root, agentDir, projectTrusted: false }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SandlotConfigError);
    expect((error as SandlotConfigError).source).toBe(policyPath);
    expect((error as Error & { cause?: unknown }).cause).toBeDefined();
  });

  it("fails closed for invalid trusted project files", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-config-"));
    const projectDir = join(root, CONFIG_DIR_NAME);
    const policyPath = join(projectDir, "sandlot.json");
    await mkdir(projectDir);
    await writeFile(policyPath, "not-json");
    await expect(loadPolicyFiles({ cwd: root, agentDir: join(root, "agent"), projectTrusted: true }))
      .rejects.toMatchObject({ source: policyPath });

    await writeFile(policyPath, JSON.stringify({ enabled: false }));
    await expect(loadPolicyFiles({ cwd: root, agentDir: join(root, "agent"), projectTrusted: true }))
      .rejects.toThrow(/enabled/);
  });

  it("defaults to no network and workspace-only writes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sandlot-config-"));
    await writeFile(join(cwd, ".env.integration"), "TOKEN=secret");
    const agentDir = "/custom/pi/agent";
    const policy = secureUserDefaults(cwd, agentDir);
    expect(policy.network.allowedDomains).toEqual([]);
    expect(policy.network.strictAllowlist).toBe(true);
    expect(policy.network.allowUnixSockets).toEqual([]);
    expect(policy.network.allowLocalBinding).toBe(false);
    expect(policy.filesystem.allowWrite).toEqual([cwd]);
    expect(policy.filesystem.denyRead).toEqual(expect.arrayContaining([
      join(homedir(), ".ssh"),
      join(homedir(), ".config", "gh"),
      join(homedir(), ".docker"),
      join(homedir(), ".config", "containers"),
      join(homedir(), ".cargo", "credentials"),
      join(homedir(), ".cargo", "credentials.toml"),
      join(homedir(), ".gnupg"),
      join(homedir(), ".m2", "settings.xml"),
      join(homedir(), ".gradle", "gradle.properties"),
      agentDir,
      join(agentDir, "auth.json"),
      join(agentDir, "sessions"),
      join(cwd, ".npmrc"),
      join(cwd, ".pypirc"),
      join(cwd, ".netrc"),
      join(cwd, ".git-credentials"),
    ]));
    expect(policy.filesystem.denyRead).not.toContain(dirname(agentDir));
    expect(policy.filesystem.denyRead).not.toContain(join(dirname(agentDir), "auth.json"));
    expect(policy.filesystem.denyWrite).toEqual(expect.arrayContaining([
      join(cwd, CONFIG_DIR_NAME),
      join(cwd, ".git", "config"),
      join(cwd, ".env"),
      join(cwd, ".env.local"),
      join(cwd, ".env.integration"),
    ]));
    expect(policy.environment).toEqual({ passThrough: [], deny: [], exposePiSessionMetadata: false });
    expect(policy.trustedCustomTools).toEqual([]);
    expect(policy.enableWeakerNestedSandbox).toBe(false);
    expect(policy.enableWeakerNetworkIsolation).toBe(false);
    expect(policy.allowAppleEvents).toBe(false);
    expect(policy).not.toHaveProperty("allowPty");
  });
});
