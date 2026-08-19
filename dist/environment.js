import { fileURLToPath } from "node:url";
const DEFAULT_ENV_NAMES = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "TMPDIR", "TMP", "TEMP"];
/** Directory containing the immutable package-owned macOS compatibility shims. */
export function sandlotMktempShimDirectory() {
    return fileURLToPath(new URL("../bin/", import.meta.url));
}
export function buildOuterEnvironment(platform, _host, temporaryDirectory) {
    if (platform !== "darwin" && platform !== "linux") {
        throw new Error(`Cannot construct Sandlot outer environment for unsupported platform ${platform}`);
    }
    const environment = {
        PATH: platform === "darwin"
            ? `${sandlotMktempShimDirectory()}:/usr/bin:/bin:/usr/sbin:/sbin`
            : "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "C",
        LC_ALL: "C",
    };
    if (temporaryDirectory === undefined) {
        environment.TMPDIR = platform === "darwin" ? "/private/tmp" : "/tmp";
    }
    else {
        environment.TMPDIR = temporaryDirectory;
        environment.TMP = temporaryDirectory;
        environment.TEMP = temporaryDirectory;
    }
    return environment;
}
/** Build a command whose environment overlay is evaluated by the already-confined shell. */
export function buildSandboxedChildCommand(command, childEnvironment, shellPath = "/bin/bash") {
    if (!shellPath.startsWith("/"))
        throw new Error("Sandboxed child shell path must be absolute");
    const assignments = Object.entries(childEnvironment).map(([name, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
            throw new Error(`Invalid sandbox child environment name: ${name}`);
        if (value === undefined)
            return undefined;
        if (value.includes("\0"))
            throw new Error(`Sandbox child environment value for ${name} contains NUL`);
        return quoteForPosixShell(`${name}=${value}`);
    }).filter((value) => value !== undefined);
    return [
        "exec /usr/bin/env",
        ...assignments,
        quoteForPosixShell(shellPath),
        "-c",
        quoteForPosixShell(command),
    ].join(" ");
}
export function buildChildEnvironment(host, policy, session) {
    const child = Object.create(null);
    for (const name of new Set([...DEFAULT_ENV_NAMES, ...(policy.passThrough ?? [])])) {
        if (Object.hasOwn(host, name) && host[name] !== undefined)
            child[name] = host[name];
    }
    if (policy.exposePiSessionMetadata && session) {
        for (const name of ["PI_SESSION_ID", "PI_PROVIDER", "PI_MODEL"]) {
            if (Object.hasOwn(session, name) && session[name] !== undefined)
                child[name] = session[name];
        }
    }
    for (const name of policy.deny ?? [])
        delete child[name];
    return child;
}
function quoteForPosixShell(value) {
    return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}
