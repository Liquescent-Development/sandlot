import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectPolicy, UserPolicy } from "../../src/config.js";
import { SandlotConfigError } from "../../src/config.js";
import {
  composePolicy,
  domainPatternCovers,
  toSandboxRuntimeConfig,
  validatePolicyForPlatform,
  type EffectivePolicy,
} from "../../src/policy.js";

describe("permission ceiling semantics", () => {
  it.each([
    ["*.github.com", "api.github.com", true],
    ["api.github.com", "*.github.com", false],
    ["example.com:443", "example.com:443", true],
    ["example.com:443", "example.com", false],
    ["example.com", "example.com:443", true],
    ["*.github.com", "github.com", false],
    ["[::1]", "[::1]:443", true],
    ["[0:0:0:0:0:0:0:1]", "[::1]", true],
  ])("covers %s -> %s", (ceiling, requested, expected) => {
    expect(domainPatternCovers(ceiling, requested)).toBe(expected);
  });
});

describe("policy composition", () => {
  async function fixture(): Promise<{ root: string; user: UserPolicy; project: ProjectPolicy }> {
    const root = await mkdtemp(join(tmpdir(), "sandlot-policy-"));
    const allowedRead = join(root, "read");
    const allowedWrite = join(root, "write");
    const socket = join(root, "service.sock");
    await Promise.all([mkdir(allowedRead), mkdir(allowedWrite)]);

    return {
      root,
      user: {
        network: {
          allowedDomains: ["*.github.com", "example.com:443"],
          deniedDomains: ["blocked.example.com"],
          allowUnixSockets: [socket],
          allowMachLookup: ["com.example.service"],
          allowAllUnixSockets: true,
          allowLocalBinding: true,
        },
        filesystem: {
          allowRead: [allowedRead],
          denyRead: [join(root, "private")],
          allowWrite: [allowedWrite],
          denyWrite: [join(root, "write", ".env")],
          disabled: true,
          allowGitConfig: true,
        },
        trustedCustomTools: ["approved-tool"],
        enableWeakerNestedSandbox: true,
        enableWeakerNetworkIsolation: true,
        allowAppleEvents: true,
      },
      project: {
        network: {
          allowedDomains: ["api.github.com"],
          deniedDomains: ["blocked.example.com", "project-blocked.example.com"],
          allowUnixSockets: [socket],
          allowMachLookup: ["com.example.service"],
          allowAllUnixSockets: false,
          allowLocalBinding: false,
        },
        filesystem: {
          allowRead: [join(allowedRead, "child")],
          denyRead: [join(root, "project-secret")],
          allowWrite: [join(allowedWrite, "child")],
          denyWrite: [join(root, "project-output")],
          disabled: false,
          allowGitConfig: false,
        },
        trustedCustomTools: ["approved-tool"],
        enableWeakerNestedSandbox: false,
        enableWeakerNetworkIsolation: false,
        allowAppleEvents: false,
      },
    };
  }

  it("uses covered project allowlists, unions denials, and applies project tightening", async () => {
    const { root, user, project } = await fixture();
    const canonicalRoot = await realpath(root);

    const effective = await composePolicy(user, project, { cwd: root, agentDir: join(root, "agent") });

    expect(effective.network.allowedDomains).toEqual(["api.github.com"]);
    expect(effective.network.deniedDomains).toEqual(["blocked.example.com", "project-blocked.example.com"]);
    expect(effective.filesystem.allowRead).toEqual([join(canonicalRoot, "read", "child")]);
    expect(effective.filesystem.allowWrite).toEqual([join(canonicalRoot, "write", "child")]);
    expect(effective.filesystem.denyRead).toEqual([
      join(root, "private"),
      join(canonicalRoot, "private"),
      join(root, "project-secret"),
      join(canonicalRoot, "project-secret"),
    ]);
    expect(effective.filesystem.denyWrite).toEqual([
      join(root, "write", ".env"),
      join(canonicalRoot, "write", ".env"),
      join(root, "project-output"),
      join(canonicalRoot, "project-output"),
    ]);
    expect(effective.network.allowUnixSockets).toEqual([join(canonicalRoot, "service.sock")]);
    expect(effective.network.allowMachLookup).toEqual(["com.example.service"]);
    expect(effective.trustedCustomTools).toEqual(["approved-tool"]);
    expect(effective.network.allowAllUnixSockets).toBe(false);
    expect(effective.network.allowLocalBinding).toBe(false);
    expect(effective.filesystem.disabled).toBe(false);
    expect(effective.filesystem.allowGitConfig).toBe(false);
    expect(effective.enableWeakerNestedSandbox).toBe(false);
    expect(effective.enableWeakerNetworkIsolation).toBe(false);
    expect(effective.allowAppleEvents).toBe(false);

    expect(toSandboxRuntimeConfig(effective)).toMatchObject({
      network: { strictAllowlist: true, allowedDomains: ["api.github.com"] },
      filesystem: { allowWrite: [join(canonicalRoot, "write", "child")] },
    });
  });

  it.each([
    ["network.allowedDomains", (root: string): ProjectPolicy => ({ network: { allowedDomains: ["evil.example.com"] } })],
    ["filesystem.allowRead", (root: string): ProjectPolicy => ({ filesystem: { allowRead: [join(root, "elsewhere")] } })],
    ["filesystem.allowWrite", (root: string): ProjectPolicy => ({ filesystem: { allowWrite: [join(root, "elsewhere")] } })],
    ["network.allowUnixSockets", (root: string): ProjectPolicy => ({ network: { allowUnixSockets: [join(root, "other.sock")] } })],
    ["network.allowMachLookup", (_root: string): ProjectPolicy => ({ network: { allowMachLookup: ["com.example.other"] } })],
    ["trustedCustomTools", (_root: string): ProjectPolicy => ({ trustedCustomTools: ["untrusted-tool"] })],
  ])("rejects a project widening %s", async (field, projectFor) => {
    const { root, user } = await fixture();

    const error = await composePolicy(user, projectFor(root), { cwd: root, agentDir: join(root, "agent") })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SandlotConfigError);
    expect(error).toHaveProperty("message", expect.stringContaining(field));
  });

  it("requires credential injection hosts to remain covered by the effective allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-policy-"));
    const user: UserPolicy = {
      network: { allowedDomains: ["*.github.com"], tlsTerminate: {} },
      credentials: {
        envVars: [{ name: "TOKEN", mode: "mask", injectHosts: ["api.github.com"] }],
      },
    };

    await expect(composePolicy(user, undefined, { cwd: root, agentDir: join(root, "agent") }))
      .resolves.toBeDefined();
    await expect(composePolicy({
      ...user,
      credentials: { envVars: [{ name: "TOKEN", mode: "mask", injectHosts: ["evil.example.com"] }] },
    }, undefined, { cwd: root, agentDir: join(root, "agent") })).rejects.toThrow(/credentials\.envVars\[0\]\.injectHosts/);
  });

  it("treats credential injection coverage as host-scoped when the network allowlist narrows a port", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-policy-"));
    const user: UserPolicy = {
      network: { allowedDomains: ["example.com:443"], tlsTerminate: {} },
      credentials: { envVars: [{ name: "TOKEN", mode: "mask", injectHosts: ["example.com"] }] },
    };

    await expect(composePolicy(user, undefined, { cwd: root, agentDir: join(root, "agent") })).resolves.toBeDefined();
  });

  it("canonicalizes trusted TLS and executable override paths before runtime use", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-policy-"));
    await Promise.all([
      "ca.pem", "ca-key.pem", "extra.pem", "rg", "bwrap", "socat", "seccomp", "seccomp-argv0",
    ].map((file) => writeFile(join(root, file), "placeholder")));

    const effective = await composePolicy({
      network: {
        tlsTerminate: { caCertPath: "ca.pem", caKeyPath: "ca-key.pem", extraCaCertPaths: ["extra.pem"] },
      },
      ripgrep: { command: "rg" },
      bwrapPath: "bwrap",
      socatPath: "socat",
      seccomp: { applyPath: "seccomp", argv0: "seccomp-argv0" },
    }, undefined, { cwd: root, agentDir: join(root, "agent") });
    const canonicalRoot = await realpath(root);

    expect(effective.network.tlsTerminate).toEqual({
      caCertPath: join(canonicalRoot, "ca.pem"),
      caKeyPath: join(canonicalRoot, "ca-key.pem"),
      extraCaCertPaths: [join(canonicalRoot, "extra.pem")],
    });
    expect(effective.ripgrep).toEqual({ command: join(canonicalRoot, "rg") });
    expect(effective.bwrapPath).toBe(join(canonicalRoot, "bwrap"));
    expect(effective.socatPath).toBe(join(canonicalRoot, "socat"));
    expect(effective.seccomp).toEqual({ applyPath: join(canonicalRoot, "seccomp"), argv0: join(canonicalRoot, "seccomp-argv0") });
  });

  it("accepts a custom credential file only under its canonical spelling", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sandlot-policy-")));
    const credentialPath = join(root, "credential.txt");
    await writeFile(credentialPath, "secret");

    const effective = await composePolicy({
      credentials: { files: [{ path: credentialPath, mode: "deny" }] },
    }, undefined, { cwd: root, agentDir: join(root, "agent") });

    expect(effective.credentials?.files).toEqual([{ path: credentialPath, mode: "deny" }]);
  });

  it("rejects a custom credential path with a symlinked final component", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sandlot-policy-")));
    const target = join(root, "credential.txt");
    const alias = join(root, "credential-link");
    await writeFile(target, "secret");
    await symlink(target, alias);

    await expect(composePolicy({
      credentials: { files: [{ path: alias, mode: "deny" }] },
    }, undefined, { cwd: root, agentDir: join(root, "agent") }))
      .rejects.toThrow(/credentials\.files\[0\]\.path.*(?:symlink|canonical)/i);
  });

  it("rejects a custom credential path with a symlinked parent component", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sandlot-policy-")));
    const targetDirectory = join(root, "credential-directory");
    const aliasDirectory = join(root, "credential-directory-link");
    await mkdir(targetDirectory);
    await writeFile(join(targetDirectory, "credential.txt"), "secret");
    await symlink(targetDirectory, aliasDirectory, "dir");

    await expect(composePolicy({
      credentials: { files: [{ path: join(aliasDirectory, "credential.txt"), mode: "deny" }] },
    }, undefined, { cwd: root, agentDir: join(root, "agent") }))
      .rejects.toThrow(/credentials\.files\[0\]\.path.*(?:symlink|canonical)/i);
  });

  it("uses canonical paths when checking project containment", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-policy-"));
    const target = join(root, "target");
    await mkdir(target);
    await symlink(target, join(root, "read-link"));

    const effective = await composePolicy({ filesystem: { allowRead: [join(root, "read-link")] } }, {
      filesystem: { allowRead: [join(target, "child")] },
    }, { cwd: root, agentDir: join(root, "agent") });

    expect(effective.filesystem.allowRead).toEqual([join(await realpath(target), "child")]);
  });

  it("retains lexical and canonical spellings for symlinked control-plane denies", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-policy-"));
    const agentDir = join(root, "agent");
    const controlTarget = join(root, "control-target");
    const lexicalControlPath = join(root, ".pi");
    await Promise.all([mkdir(agentDir), mkdir(controlTarget)]);
    await symlink(controlTarget, lexicalControlPath, "dir");

    const effective = await composePolicy({}, undefined, { cwd: root, agentDir });

    expect(effective.filesystem.denyWrite).toEqual(expect.arrayContaining([
      lexicalControlPath,
      await realpath(controlTarget),
    ]));
  });

  it("materializes every Sandbox Runtime mandatory control-plane deny at the Pi invocation root", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-policy-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir);

    const effective = await composePolicy({}, undefined, { cwd: root, agentDir });

    expect(effective.filesystem.denyWrite).toEqual(expect.arrayContaining([
      ".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile",
      ".ripgreprc", ".mcp.json", ".vscode", ".idea", ".claude/commands", ".claude/agents",
    ].map((path) => join(root, path))));
  });

  it("composes defaults for a Git worktree and protects its real control paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-policy-"));
    const workspace = join(root, "worktree");
    const agentDir = join(root, "agent");
    const commonGitDir = join(root, "repository.git");
    const worktreeGitDir = join(commonGitDir, "worktrees", "topic");
    await Promise.all([
      mkdir(workspace),
      mkdir(agentDir),
      mkdir(join(commonGitDir, "hooks"), { recursive: true }),
      mkdir(worktreeGitDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(workspace, ".git"), `gitdir: ${worktreeGitDir}\n`),
      writeFile(join(worktreeGitDir, "commondir"), "../..\n"),
      writeFile(join(commonGitDir, "config"), "[core]\n"),
    ]);

    const effective = await composePolicy({}, undefined, { cwd: workspace, agentDir });

    expect(effective.filesystem.denyWrite).toEqual(expect.arrayContaining([
      join(workspace, ".git"),
      join(await realpath(commonGitDir), "config"),
      join(await realpath(commonGitDir), "hooks"),
    ]));
  });

  it("rejects Linux write globs and unmaterialized allow-write roots before ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-policy-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    const globPolicy = await composePolicy({
      filesystem: { allowWrite: [join(root, "projects", "*")] },
    }, undefined, { cwd: root, agentDir });
    const missingPolicy = await composePolicy({
      filesystem: { allowWrite: [join(root, "missing")] },
    }, undefined, { cwd: root, agentDir });

    await expect(validatePolicyForPlatform(globPolicy, "linux", "x64"))
      .rejects.toThrow(/Linux.*glob.*allowWrite/i);
    await expect(validatePolicyForPlatform(missingPolicy, "darwin", "arm64"))
      .rejects.toThrow(/allowWrite.*existing directory/i);
  });

  it("supports Linux only on architectures with pinned seccomp filters", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-policy-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    const effective = await composePolicy({}, undefined, { cwd: root, agentDir });

    await expect(validatePolicyForPlatform(effective, "linux", "riscv64"))
      .rejects.toThrow(/Linux.*x64.*arm64.*riscv64/i);
    await expect(validatePolicyForPlatform(effective, "linux", "x64")).resolves.toBeUndefined();
    await expect(validatePolicyForPlatform(effective, "linux", "arm64")).resolves.toBeUndefined();
  });

  it("allows a project to remove all entries from replaceable permission lists", async () => {
    const { root, user } = await fixture();
    const effective = await composePolicy(user, {
      network: { allowedDomains: [], allowUnixSockets: [], allowMachLookup: [] },
      filesystem: { allowRead: [], allowWrite: [] },
      trustedCustomTools: [],
    }, { cwd: root, agentDir: join(root, "agent") });

    expect(effective.network.allowedDomains).toEqual([]);
    expect(effective.network.allowUnixSockets).toEqual([]);
    expect(effective.network.allowMachLookup).toEqual([]);
    expect(effective.filesystem.allowRead).toEqual([]);
    expect(effective.filesystem.allowWrite).toEqual([]);
    expect(effective.trustedCustomTools).toEqual([]);
  });

  it("preserves filtered network defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-policy-"));
    const effective = await composePolicy({}, undefined, { cwd: root, agentDir: join(root, "agent") });

    expect(effective.networkMode).toBe("filtered");
    expect(toSandboxRuntimeConfig(effective).network).toMatchObject({
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    });
  });

  it("composes unrestricted user network mode without domain filtering", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-policy-"));
    const effective = await composePolicy({ network: { mode: "unrestricted" } }, undefined, {
      cwd: root,
      agentDir: join(root, "agent"),
    });

    expect(effective.networkMode).toBe("unrestricted");
    expect(effective.network.allowedDomains).toEqual([]);
    expect(effective.network.deniedDomains).toEqual([]);
    expect(toSandboxRuntimeConfig(effective).network).toMatchObject({
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: false,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    });
  });

  it("rejects every project network block in unrestricted user mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-policy-"));

    await expect(composePolicy({ network: { mode: "unrestricted" } }, { network: {} }, {
      cwd: root,
      agentDir: join(root, "agent"),
    })).rejects.toThrow(/project policy.*network.*unrestricted|network.*unrestricted.*project policy/i);
  });

  it("allows deny-only credentials but rejects injected credentials in unrestricted user mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-policy-"));
    const context = { cwd: root, agentDir: join(root, "agent") };

    await expect(composePolicy({
      network: { mode: "unrestricted" },
      credentials: { envVars: [{ name: "TOKEN", mode: "deny" }] },
    }, undefined, context)).resolves.toBeDefined();
    const masked = await composePolicy({
      network: { mode: "unrestricted" },
      credentials: { envVars: [{ name: "TOKEN", mode: "mask" }] },
    }, undefined, context);
    expect(toSandboxRuntimeConfig(masked).credentials?.envVars).toEqual([{ name: "TOKEN", mode: "deny" }]);
    await expect(composePolicy({
      network: { mode: "unrestricted" },
      credentials: { envVars: [{ name: "TOKEN", mode: "deny", injectHosts: ["api.example.com"] }] },
    }, undefined, context)).rejects.toThrow(/credentials\.envVars\[0\]\.injectHosts.*unrestricted/i);
  });

  it("removes forged Runtime network authority during conversion", async () => {
    const { root, user, project } = await fixture();
    const effective = await composePolicy(user, project, { cwd: root, agentDir: join(root, "agent") });
    const forged = {
      ...effective,
      network: {
        ...effective.network,
        strictAllowlist: false,
        httpProxyPort: 8443,
        socksProxyPort: 1080,
        mitmProxy: { socketPath: "/tmp/mitm.sock", domains: ["api.github.com"] },
        parentProxy: { https: "http://proxy.example.com" },
        filterRequest: () => ({ action: "allow" as const }),
      },
    } as unknown as EffectivePolicy;

    const runtime = toSandboxRuntimeConfig(forged);

    expect(runtime.network.strictAllowlist).toBe(true);
    expect(runtime.network).not.toHaveProperty("httpProxyPort");
    expect(runtime.network).not.toHaveProperty("socksProxyPort");
    expect(runtime.network).not.toHaveProperty("mitmProxy");
    expect(runtime.network).not.toHaveProperty("parentProxy");
    expect(runtime.network).not.toHaveProperty("filterRequest");
  });

  it("fails closed if an unchecked project policy enables a dangerous boolean", async () => {
    const { root, user } = await fixture();
    const uncheckedProject = { network: { allowLocalBinding: true } } as unknown as ProjectPolicy;

    await expect(composePolicy(user, uncheckedProject, { cwd: root, agentDir: join(root, "agent") }))
      .rejects.toThrow(/network\.allowLocalBinding/);
  });

  it.each([
    ["network.allowAllUnixSockets", () => ({ network: { allowAllUnixSockets: true } })],
    ["network.allowLocalBinding", () => ({ network: { allowLocalBinding: true } })],
    ["filesystem.disabled", () => ({ filesystem: { disabled: true } })],
    ["filesystem.allowGitConfig", () => ({ filesystem: { allowGitConfig: true } })],
    ["enableWeakerNestedSandbox", () => ({ enableWeakerNestedSandbox: true })],
    ["enableWeakerNetworkIsolation", () => ({ enableWeakerNetworkIsolation: true })],
    ["allowAppleEvents", () => ({ allowAppleEvents: true })],
  ])("names every forged dangerous project boolean widening", async (field, projectFor) => {
    const { root, user } = await fixture();

    await expect(composePolicy(user, projectFor() as unknown as ProjectPolicy, { cwd: root, agentDir: join(root, "agent") }))
      .rejects.toThrow(new RegExp(field.replaceAll(".", "\\.")));
  });
});
