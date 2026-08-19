import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseProjectPolicy, parseUserPolicy } from "../../dist/config.js";
import { packArtifact, PROJECT_ROOT, run } from "./harness.js";

describe("packed Sandlot release artifact", () => {
  let packed: Awaited<ReturnType<typeof packArtifact>>;
  let entries: string[];
  let readme: string;
  let manifest: {
    scripts?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  beforeAll(async () => {
    packed = await packArtifact();
    const listing = await run("tar", ["-tzf", packed.tarball], {
      cwd: packed.directory,
      timeoutMs: 30_000,
    });
    if (listing.code !== 0) throw new Error(`tar listing failed: ${listing.stderr}`);
    entries = listing.stdout.trim().split("\n");
    readme = await readPackedText("package/README.md");
    manifest = JSON.parse(await readPackedText("package/package.json")) as typeof manifest;

    async function readPackedText(path: string): Promise<string> {
      const result = await run("tar", ["-xOf", packed.tarball, path], {
        cwd: packed.directory,
        timeoutMs: 30_000,
      });
      if (result.code !== 0) throw new Error(`could not read ${path} from tarball: ${result.stderr}`);
      return result.stdout;
    }
  }, 90_000);

  afterAll(async () => packed?.cleanup());

  it("ships every executable boundary helper and operator document", () => {
    expect(entries).toEqual(expect.arrayContaining([
      "package/dist/index.js",
      "package/dist/helpers/file-worker.js",
      "package/dist/helpers/image-worker.js",
      "package/dist/helpers/protocol.js",
      "package/dist/helpers/sandbox-runtime-service.js",
      "package/dist/helpers/search-worker.js",
      "package/bin/mktemp",
      "package/README.md",
      "package/SPEC.md",
      "package/LICENSE",
      "package/scripts/pack-check.mjs",
    ]));
  });

  it("documents every required operating and security contract", async () => {
    for (const heading of [
      "Installation",
      "Threat model",
      "Configuration",
      "Diagnostics",
      "Explicit disable",
      "Limitations",
    ]) {
      expect(readme, `README is missing the ${heading} heading`).toMatch(
        new RegExp(`^##\\s+${heading}$`, "im"),
      );
    }
  });

  it("places the clean release build before every artifact smoke and never rebuilds afterward", () => {
    expect(manifest.scripts?.prepublishOnly).toBe(
      "npm test && npm run typecheck && npm run build && npm run test:smoke",
    );
    expect(manifest.scripts?.prepublishOnly).not.toMatch(/npm\s+(?:pack|publish)|pack:check/);
    expect(manifest.scripts?.["release:verify"]).toBe(
      "npm test && npm run typecheck && npm run build && SANDLOT_REQUIRE_INTEGRATION=1 npm run test:integration && npm run test:smoke && npm run pack:check",
    );
    expect(manifest.scripts?.["pack:check"]).toBe("node scripts/pack-check.mjs");
  });

  it("keeps host-provided Pi out of Pi's Git dependency installation", () => {
    expect(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBeUndefined();
    expect(manifest.devDependencies?.["@earendil-works/pi-coding-agent"]).toBe("0.84.2");
  });

  it("ships JSON examples accepted by the real strict user and project parsers", () => {
    const examples = [...readme.matchAll(/```json\s*\n([\s\S]*?)```/g)]
      .map((match) => JSON.parse(match[1]!) as unknown);
    expect(examples).toHaveLength(3);
    expect(() => parseUserPolicy(examples[0], "packed README user example")).not.toThrow();
    expect(() => parseProjectPolicy(examples[1], "packed README project example")).not.toThrow();
    expect(() => parseUserPolicy(examples[2], "packed README disable example")).not.toThrow();
  });

  it("tracks generated release entrypoints so pinned Pi Git installs can load", async () => {
    for (const path of [
      "dist/index.js",
      "dist/helpers/file-worker.js",
      "dist/helpers/image-worker.js",
      "dist/helpers/protocol.js",
      "dist/helpers/sandbox-runtime-service.js",
      "dist/helpers/search-worker.js",
      "bin/mktemp",
    ]) {
      const tracked = await run("git", ["ls-files", "--error-unmatch", path], {
        cwd: PROJECT_ROOT,
      });
      expect(tracked.code, `${path} must be committed in release refs`).toBe(0);
    }
  });
});
