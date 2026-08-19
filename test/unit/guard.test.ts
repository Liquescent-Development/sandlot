import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertProtectedOwnership, evaluateToolCall, type GuardInput } from "../../src/guard.js";

const protectedToolNames = ["bash", "read", "write", "edit", "ls", "find", "grep"] as const;
let sourceRoot = "";
let sandlotSourcePath = "";
let linkedSourcePath = "";

function tool(name: string, source = "extension", path = sandlotSourcePath): ToolInfo {
  return {
    name,
    description: `${name} tool`,
    parameters: {} as ToolInfo["parameters"],
    promptGuidelines: [],
    sourceInfo: { path, source, scope: "project", origin: "top-level" },
  };
}

function guardInput(overrides: Partial<GuardInput> = {}): GuardInput {
  return {
    toolName: "bash",
    state: "ready",
    tools: [tool("bash")],
    sandlotSourcePath,
    trustedCustomTools: [],
    ...overrides,
  };
}

describe("live tool ownership and custom-tool guard", () => {
  beforeAll(async () => {
    sourceRoot = await mkdtemp(join(tmpdir(), "sandlot-guard-"));
    sandlotSourcePath = join(sourceRoot, "index.js");
    linkedSourcePath = join(sourceRoot, "linked-index.js");
    await writeFile(sandlotSourcePath, "export default undefined;");
    await symlink(sandlotSourcePath, linkedSourcePath);
  });

  afterAll(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
  });

  it.each(protectedToolNames)("allows Sandlot-owned protected tool %s", (toolName) => {
    // A replacement source must make this test fail.
    expect(evaluateToolCall(guardInput({ toolName, tools: [tool(toolName)] }))).toEqual({ block: false });
  });

  it("canonicalizes the injected entry-module source before checking protected ownership", () => {
    // Removing path resolution would block Sandlot's own tool when Pi reports an equivalent path.
    expect(evaluateToolCall(guardInput({
      tools: [tool("bash", "extension", join(sourceRoot, "dist", "..", "index.js"))],
    }))).toEqual({ block: false });
  });

  it("canonicalizes symlinked extension source paths before checking protected ownership", () => {
    // Replacing real-path canonicalization with lexical resolution would block Sandlot when Pi reports a symlink.
    expect(evaluateToolCall(guardInput({
      tools: [tool("bash", "extension", linkedSourcePath)],
    }))).toEqual({ block: false });
  });

  it.each([
    ["the ToolInfo source", () => pathToFileURL(sandlotSourcePath).href, () => sandlotSourcePath],
    ["the injected entry source", () => sandlotSourcePath, () => pathToFileURL(sandlotSourcePath).href],
    ["both sources", () => pathToFileURL(sandlotSourcePath).href, () => pathToFileURL(sandlotSourcePath).href],
  ])("accepts a file URL for %s", (_position, toolSource, entrySource) => {
    // Passing file URLs to path.resolve would reject a valid Sandlot-owned tool.
    expect(evaluateToolCall(guardInput({
      tools: [tool("bash", "extension", toolSource())],
      sandlotSourcePath: entrySource(),
    }))).toEqual({ block: false });
  });

  it("fails closed when a protected source is an invalid file URL", () => {
    // Treating a malformed file URL as a lexical filesystem path could manufacture ownership.
    expect(evaluateToolCall(guardInput({
      tools: [tool("bash", "extension", "file:///tmp/%ZZ")],
    }))).toEqual({ block: true, reason: expect.stringMatching(/ownership/) });
  });

  it("blocks equal missing source paths for a protected tool", () => {
    // Returning lexical paths for ENOENT would allow a nonexistent owner to pass.
    const missingSourcePath = join(sourceRoot, "missing.js");
    expect(evaluateToolCall(guardInput({
      tools: [tool("bash", "extension", missingSourcePath)],
      sandlotSourcePath: missingSourcePath,
    }))).toEqual({ block: true, reason: expect.stringMatching(/ownership/) });
  });

  it("blocks equal broken symlink source paths for a protected tool", async () => {
    // Returning lexical paths for broken symlinks would allow a noncanonical owner to pass.
    const brokenLink = join(sourceRoot, "broken-index.js");
    await symlink(join(sourceRoot, "missing-target.js"), brokenLink);
    expect(evaluateToolCall(guardInput({
      tools: [tool("bash", "extension", brokenLink)],
      sandlotSourcePath: brokenLink,
    }))).toEqual({ block: true, reason: expect.stringMatching(/ownership/) });
  });

  it("blocks a protected tool replaced by a later extension", () => {
    // Removing the ownership comparison would allow an unsandboxed replacement.
    expect(evaluateToolCall(guardInput({
      tools: [tool("bash", "extension", "/other.ts")],
    }))).toEqual({ block: true, reason: expect.stringMatching(/ownership/) });
  });

  it("fails closed when a protected tool reports an invalid source path", () => {
    // Letting path-canonicalization failures escape would leave the caller without a block decision.
    expect(evaluateToolCall(guardInput({
      tools: [tool("bash", "extension", "/other\0.ts")],
    }))).toEqual({ block: true, reason: expect.stringMatching(/ownership/) });
  });

  it("allows a built-in tool outside Sandlot's protected set", () => {
    // Treating every tool as protected would incorrectly block normal Pi built-ins.
    expect(evaluateToolCall(guardInput({
      toolName: "browser",
      tools: [tool("browser", "builtin", "/pi/browser.js")],
    }))).toEqual({ block: false });
  });

  it.each(["extension", "sdk"])("blocks an untrusted %s custom tool", (source) => {
    // Omitting the custom-tool membership check would allow direct host access.
    expect(evaluateToolCall(guardInput({
      toolName: "custom-tool",
      tools: [tool("custom-tool", source, "/custom.ts")],
    }))).toEqual({ block: true, reason: "Custom tool is not trusted: custom-tool" });
  });

  it("requires an exact trusted custom-tool name", () => {
    // Substring or case-insensitive matching would allow an unapproved custom tool.
    expect(evaluateToolCall(guardInput({
      toolName: "safe-tool-extra",
      tools: [tool("safe-tool-extra", "extension", "/custom.ts")],
      trustedCustomTools: ["safe-tool"],
    }))).toEqual({ block: true, reason: "Custom tool is not trusted: safe-tool-extra" });

    expect(evaluateToolCall(guardInput({
      toolName: "safe-tool",
      tools: [tool("safe-tool", "extension", "/custom.ts")],
      trustedCustomTools: ["safe-tool"],
    }))).toEqual({ block: false });
  });

  it("blocks a custom tool removed from the effective project trusted-tool list", () => {
    // Falling back to a wider user list would ignore the project's deliberate removal.
    expect(evaluateToolCall(guardInput({
      toolName: "safe-tool",
      tools: [tool("safe-tool", "extension", "/custom.ts")],
      trustedCustomTools: [],
    }))).toEqual({ block: true, reason: "Custom tool is not trusted: safe-tool" });
  });

  it.each(["idle", "initializing", "failed", "shutting-down"] as const)("blocks while Sandlot is %s", (state) => {
    // Allowing a non-ready enabled state would permit Pi's unsandboxed implementation.
    expect(evaluateToolCall(guardInput({ state }))).toEqual({ block: true, reason: `Sandlot is ${state}` });
  });

  it("does not restrict Pi when explicitly disabled by the user", () => {
    // Checking ownership before the explicit disable bypass would still interfere with normal Pi tools.
    expect(evaluateToolCall(guardInput({
      state: "disabled-by-user",
      tools: [],
    }))).toEqual({ block: false });
  });

  it("blocks an unregistered tool while enabled", () => {
    // Treating a missing registry entry as safe would fail open during registry changes.
    expect(evaluateToolCall(guardInput({ toolName: "missing", tools: [] })))
      .toEqual({ block: true, reason: "Tool is not registered: missing" });
  });

  it("asserts that every protected tool is owned by Sandlot", () => {
    // Accepting a missing or replaced protected entry would make startup validation ineffective.
    const tools = protectedToolNames.map((name) => tool(name));

    expect(() => assertProtectedOwnership(tools, sandlotSourcePath)).not.toThrow();
    expect(() => assertProtectedOwnership([...tools.slice(1), tool("bash", "extension", "/other.ts")], sandlotSourcePath))
      .toThrow(/ownership/);
    expect(() => assertProtectedOwnership(tools.slice(1), sandlotSourcePath)).toThrow(/ownership/);
  });
});
