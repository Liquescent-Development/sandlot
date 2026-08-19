import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildChildEnvironment,
  buildOuterEnvironment,
  buildSandboxedChildCommand,
  sandlotMktempShimDirectory,
} from "../../src/environment.js";

const execFileAsync = promisify(execFile);

describe("buildChildEnvironment", () => {
  it("passes operational values without leaking arbitrary secrets", () => {
    const env = buildChildEnvironment(
      { PATH: "/bin", LANG: "en_US.UTF-8", TERM: "xterm", ANTHROPIC_API_KEY: "secret", SAFE_FLAG: "yes" },
      { passThrough: ["SAFE_FLAG", "ANTHROPIC_API_KEY"], deny: ["ANTHROPIC_API_KEY"], exposePiSessionMetadata: false },
    );

    expect(env).toEqual({ PATH: "/bin", LANG: "en_US.UTF-8", TERM: "xterm", SAFE_FLAG: "yes" });
  });

  it("lets deny entries remove default and explicitly passed values", () => {
    const env = buildChildEnvironment(
      { PATH: "/bin", TERM: "xterm", SAFE_FLAG: "yes" },
      { passThrough: ["PATH", "SAFE_FLAG"], deny: ["PATH", "SAFE_FLAG"], exposePiSessionMetadata: false },
    );

    expect(env).toEqual({ TERM: "xterm" });
  });

  it("omits undefined values while preserving safe temporary paths", () => {
    const env = buildChildEnvironment(
      { PATH: undefined, TMPDIR: "/safe/tmp", TMP: undefined, TEMP: "/safe/temp", SECRET: undefined },
      { passThrough: ["SECRET"], deny: [], exposePiSessionMetadata: false },
    );

    expect(env).toEqual({ TMPDIR: "/safe/tmp", TEMP: "/safe/temp" });
  });

  it("exposes only provided Pi session metadata when enabled", () => {
    const session = { PI_SESSION_ID: "session-123", PI_PROVIDER: "anthropic", PI_MODEL: "claude", PI_API_KEY: "secret" };
    const hidden = buildChildEnvironment({}, { passThrough: [], deny: [], exposePiSessionMetadata: false }, session);
    const exposed = buildChildEnvironment({}, { passThrough: [], deny: [], exposePiSessionMetadata: true }, session);

    expect(hidden).toEqual({});
    expect(exposed).toEqual({ PI_SESSION_ID: "session-123", PI_PROVIDER: "anthropic", PI_MODEL: "claude" });
  });

  it("does not copy allowlisted values inherited from a polluted host prototype", () => {
    const host = Object.create({ PATH: "/attacker/bin", SAFE_FLAG: "injected" }) as NodeJS.ProcessEnv;

    const env = buildChildEnvironment(host, { passThrough: ["SAFE_FLAG"], deny: [], exposePiSessionMetadata: false });

    expect(env).toEqual({});
  });

  it("does not copy Pi metadata inherited from a polluted session prototype", () => {
    const session = Object.create({ PI_SESSION_ID: "injected", PI_PROVIDER: "injected", PI_MODEL: "injected" });

    const env = buildChildEnvironment({}, { passThrough: [], deny: [], exposePiSessionMetadata: true }, session);

    expect(env).toEqual({});
  });

  it("lets deny entries remove Pi metadata", () => {
    const env = buildChildEnvironment(
      {},
      { passThrough: [], deny: ["PI_SESSION_ID", "PI_PROVIDER", "PI_MODEL"], exposePiSessionMetadata: true },
      { PI_SESSION_ID: "session-123", PI_PROVIDER: "anthropic", PI_MODEL: "claude" },
    );

    expect(env).toEqual({});
  });

  it("returns a null-prototype object", () => {
    const env = buildChildEnvironment({ PATH: "/bin" }, { passThrough: [], deny: [], exposePiSessionMetadata: false });

    expect(Object.getPrototypeOf(env)).toBeNull();
  });
});

describe("sandbox environment boundary", () => {
  it("constructs a fixed outer environment without host PATH or loader hooks", () => {
    const outer = buildOuterEnvironment("darwin", {
      PATH: "/writable/bin",
      BASH_ENV: "/writable/bash-env",
      LD_PRELOAD: "/writable/preload.so",
      DYLD_INSERT_LIBRARIES: "/writable/preload.dylib",
      SECRET: "host-only",
    });

    expect(outer).toEqual({
      PATH: `${sandlotMktempShimDirectory()}:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: "C",
      LC_ALL: "C",
      TMPDIR: "/private/tmp",
    });
    expect(buildOuterEnvironment("linux", { PATH: "/writable/bin", LD_PRELOAD: "/writable/preload.so" }))
      .toEqual({
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "C",
        LC_ALL: "C",
        TMPDIR: "/tmp",
      });
  });

  it("applies quoted user environment only to the inner sandboxed shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-inner-env-"));
    const bashEnv = join(root, "bash env's path.sh");
    const command = buildSandboxedChildCommand(
      `printf '%s|%s' "$SAFE_CHILD_VALUE" "$BASH_ENV"`,
      { PATH: join(root, "writable-bin"), BASH_ENV: bashEnv, SAFE_CHILD_VALUE: "quoted ' child value" },
      "/bin/bash",
    );

    const result = await execFileAsync("/bin/bash", ["-c", command], {
      env: buildOuterEnvironment(process.platform, process.env),
    });

    expect(result.stdout).toBe(`quoted ' child value|${bashEnv}`);
  });
});

describe("macOS mktemp shim path", () => {
  it("places only Sandlot's packaged shim ahead of native system directories", () => {
    expect(buildOuterEnvironment("darwin", {}).PATH)
      .toBe(`${sandlotMktempShimDirectory()}:/usr/bin:/bin:/usr/sbin:/sbin`);
    expect(buildOuterEnvironment("linux", {}).PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
  });
});
