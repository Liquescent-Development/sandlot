import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const projectUrl = (path: string) => new URL(`../../${path}`, import.meta.url);
const read = (path: string) => readFile(projectUrl(path), "utf8");
const relativeLinkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;

function markdownLinks(markdown: string): string[] {
  return [...markdown.matchAll(relativeLinkPattern)].map((match) => match[1]!);
}

function isExternalOrAnchor(target: string): boolean {
  return target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

describe("public documentation", () => {
  it("gives new users a safe, stable installation path before implementation detail", async () => {
    const readme = await read("README.md");

    expect(readme).toContain("docs/assets/sandlot-logo.png");
    expect(readme).toContain("anthropic-experimental/sandbox-runtime");
    expect(readme).toContain("pi install git:github.com/Liquescent-Development/sandlot@v0.1.0");
    expect(readme.indexOf("## Quick start")).toBeLessThan(readme.indexOf("## How it works"));
    expect(readme).toContain("macOS");
    expect(readme).toMatch(/Linux[\s\S]*(deferred|unsupported)/i);
    expect(readme).toMatch(/not a whole-Pi sandbox/i);
    expect(readme).not.toContain("pi install npm:sandlot");
    expect(readme).not.toMatch(/Linux\s+(?:is\s+)?supported/i);
    for (const path of [
      "docs/configuration.md",
      "docs/security.md",
      "docs/diagnostics.md",
      "docs/development.md",
      "docs/releases.md",
      "SPEC.md",
    ]) expect(readme).toContain(path);
  });

  it("links the public documentation set without escaping the repository", async () => {
    const paths = [
      "README.md",
      "docs/configuration.md",
      "docs/security.md",
      "docs/diagnostics.md",
      "docs/development.md",
      "docs/releases.md",
    ];

    for (const path of paths) {
      const markdown = await read(path);
      for (const target of markdownLinks(markdown)) {
        if (isExternalOrAnchor(target)) continue;
        const pathname = target.split("#", 1)[0]!.split("?", 1)[0]!;
        if (pathname.length === 0) continue;
        const resolved = resolve(projectRoot, path, "..", pathname);
        expect(relative(projectRoot, resolved), `${path} links outside the repository: ${target}`)
          .not.toMatch(/^(?:\.\.(?:\/|$)|\/)/);
        await expect(access(resolved), `${path} has a broken link: ${target}`).resolves.toBeUndefined();
      }
    }
  });

  it("ships the supported docs, release notes, and official logo asset", async () => {
    for (const path of [
      "docs/configuration.md",
      "docs/security.md",
      "docs/diagnostics.md",
      "docs/development.md",
      "docs/releases.md",
      "SPEC.md",
      "CHANGELOG.md",
    ]) {
      await expect(access(projectUrl(path))).resolves.toBeUndefined();
    }

    const logo = await readFile(projectUrl("docs/assets/sandlot-logo.png"));
    expect(createHash("sha256").update(logo).digest("hex"))
      .toBe("a286c0cc43f61a026d301dfa40c180996cb4f8347fe4da507968052325aa2812");

    const changelog = await read("CHANGELOG.md");
    expect(changelog).toMatch(/^## \[Unreleased\]$/m);
    expect(changelog).toMatch(/^## \[0\.1\.0\] - 2026-08-\d{2}$/m);
  });

  it("documents fail-closed session cleanup lifecycle guarantees", async () => {
    const configuration = await read("docs/configuration.md");

    expect(configuration).toMatch(/runner-owned command and supervised descendant has positively settled/i);
    expect(configuration).toMatch(/generation-tagged service transport/i);
    expect(configuration).toMatch(/indeterminate termination or cleanup failure is surfaced/i);
  });

  it("states the supported macOS boundary, ownership, and operator contracts", async () => {
    const [readme, configuration, security, diagnostics, development] = await Promise.all([
      read("README.md"),
      read("docs/configuration.md"),
      read("docs/security.md"),
      read("docs/diagnostics.md"),
      read("docs/development.md"),
    ]);

    expect(readme).toContain("AGPL-3.0");
    expect(readme).not.toContain("Apache-2.0");
    expect(readme).toContain("actions/workflows/security.yml/badge.svg?branch=main");
    expect(readme).toMatch(/macOS.*(?:x64|arm64)/i);
    expect(readme).toContain("state: ready");
    expect(readme).toMatch(/Seatbelt[\s\S]*Sandbox Runtime/i);
    expect(readme).toMatch(/Sandlot[\s\S]*policy composition[\s\S]*protected-tool routing[\s\S]*diagnostics/i);
    expect(readme).toMatch(/project writes[\s\S]*allowed[\s\S]*protected.*(?:configuration|security)/i);
    expect(readme).toMatch(/explicitly install a newer.*tag/i);
    expect(configuration).toMatch(/^## Explicit disable$/m);
    expect(configuration).toMatch(/Warning:[\s\S]*disables the security boundary/i);
    expect(security).toMatch(/^## Responsibility boundaries$/m);
    expect(security).toMatch(/Sandlot owns[\s\S]*Sandbox Runtime owns/i);
    expect(diagnostics).toMatch(/^## Local verification$/m);
    expect(development).toMatch(/^## Prerequisites$/m);
    expect(development).toMatch(/^## Contributing$/m);
    expect(development).toMatch(/single.*`npm run release:verify`/i);
  });
});
