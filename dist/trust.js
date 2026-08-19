import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPathContained } from "./paths.js";
const EXTENSION_MODULES = [
    "index",
    "config",
    "diagnostics",
    "environment",
    "guard",
    "paths",
    "policy",
    "runner",
    "runtime",
    "sandbox-runtime-boundary",
    "helpers/file-worker",
    "helpers/image-worker",
    "helpers/protocol",
    "helpers/sandbox-runtime-service",
    "helpers/search-worker",
    "tools/bash",
    "tools/files",
    "tools/index",
    "tools/search",
    "trust",
    "violations",
];
const PI_IMAGE_MODULES = [
    "image-process.js",
    "image-convert.js",
    "image-resize.js",
    "image-resize-core.js",
    "image-resize-worker.js",
    "exif-orientation.js",
    "photon.js",
];
/** Resolve the exact ESM worker graph and host-loaded Sandlot module trust roots. */
export async function resolveExtensionTrustPaths(input) {
    const lexicalPaths = {
        entryPath: resolve(input.entryPath),
        nodePath: resolve(input.nodePath),
        fileWorkerPath: resolve(input.fileWorkerPath),
        searchWorkerPath: resolve(input.searchWorkerPath),
        rgPath: resolve(input.rgPath),
        sandboxRuntimeEntryPath: resolve(input.sandboxRuntimeEntryPath),
        piImageProcessorPath: resolve(input.piImageProcessorPath),
        photonEntryPath: resolve(input.photonEntryPath),
        photonWasmPath: resolve(input.photonWasmPath),
    };
    const additionalExecutablePaths = await Promise.all((input.additionalExecutablePaths ?? []).map((path) => requiredRealpath(resolve(path), "Sandbox security executable")));
    const [entryPath, nodePath, fileWorkerPath, searchWorkerPath, rgPath, sandboxRuntimeEntryPath, piImageProcessorPath, photonEntryPath, photonWasmPath] = await Promise.all([
        requiredRealpath(lexicalPaths.entryPath, "Sandlot entry module"),
        requiredRealpath(lexicalPaths.nodePath, "Node executable"),
        requiredRealpath(lexicalPaths.fileWorkerPath, "Sandlot file worker"),
        requiredRealpath(lexicalPaths.searchWorkerPath, "Sandlot search worker"),
        requiredRealpath(lexicalPaths.rgPath, "ripgrep executable"),
        requiredRealpath(lexicalPaths.sandboxRuntimeEntryPath, "Pinned Sandbox Runtime entry module"),
        requiredRealpath(lexicalPaths.piImageProcessorPath, "Pinned Pi image processor module (reinstall @earendil-works/pi-coding-agent 0.84.2)"),
        requiredRealpath(lexicalPaths.photonEntryPath, "Pinned Photon image module"),
        requiredRealpath(lexicalPaths.photonWasmPath, "Pinned Photon WASM module"),
    ]);
    const packageJsonPath = await findPackageJson(entryPath, { requireEsm: true, label: "Sandlot package metadata" });
    const sandboxRuntimePackageJsonPath = await findPackageJson(sandboxRuntimeEntryPath, {
        requireEsm: true,
        expectedName: "@anthropic-ai/sandbox-runtime",
        expectedVersion: "0.0.73",
        label: "Pinned Sandbox Runtime package metadata",
    });
    const sandboxRuntimeGraph = await resolvePackageDependencyGraph(sandboxRuntimePackageJsonPath);
    const platform = input.platform ?? process.platform;
    const arch = input.arch ?? process.arch;
    const seccompApplyPath = platform === "linux"
        ? await requiredExecutable(input.configuredSeccompApplyPath === undefined
            ? join(dirname(sandboxRuntimePackageJsonPath), "vendor", "seccomp", arch, "apply-seccomp")
            : resolve(input.configuredSeccompApplyPath), `Sandbox Runtime seccomp helper for Linux ${arch}`)
        : undefined;
    const bwrapPath = platform === "linux"
        ? await resolvePinnedExecutable(input.configuredBwrapPath, ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"], "bubblewrap executable")
        : undefined;
    const socatPath = platform === "linux"
        ? await resolvePinnedExecutable(input.configuredSocatPath, ["/usr/bin/socat", "/bin/socat", "/usr/local/bin/socat"], "socat executable")
        : undefined;
    const piPackageJsonPath = await findPackageJson(piImageProcessorPath, {
        requireEsm: true,
        expectedName: "@earendil-works/pi-coding-agent",
        expectedVersion: "0.84.2",
        label: "Pinned Pi package metadata",
    });
    const photonPackageJsonPath = await findPackageJson(photonEntryPath, {
        requireEsm: false,
        expectedName: "@silvia-odwyer/photon-node",
        expectedVersion: "0.3.4",
        label: "Pinned Photon package metadata",
    });
    const piPackageRoot = dirname(piPackageJsonPath);
    const photonPackageRoot = dirname(photonPackageJsonPath);
    const lexicalPiPackageRoot = resolve(dirname(lexicalPaths.piImageProcessorPath), "..", "..");
    assertExactGraphTarget("Pinned Pi image processor spelling", lexicalPaths.piImageProcessorPath, join(lexicalPiPackageRoot, "dist", "utils", "image-process.js"));
    const canonicalLexicalPiPackageRoot = await requiredRealpath(lexicalPiPackageRoot, "Pinned Pi package-root alias");
    assertExactGraphTarget("Pinned Pi package-root alias", canonicalLexicalPiPackageRoot, piPackageRoot);
    const lexicalPhotonPackageRoot = dirname(lexicalPaths.photonEntryPath);
    assertExactGraphTarget("Pinned Photon entry spelling", lexicalPaths.photonEntryPath, join(lexicalPhotonPackageRoot, "photon_rs.js"));
    assertExactGraphTarget("Pinned Photon WASM spelling", lexicalPaths.photonWasmPath, join(lexicalPhotonPackageRoot, "photon_rs_bg.wasm"));
    const canonicalLexicalPhotonPackageRoot = await requiredRealpath(lexicalPhotonPackageRoot, "Pinned Photon package-root alias");
    assertExactGraphTarget("Pinned Photon package-root alias", canonicalLexicalPhotonPackageRoot, photonPackageRoot);
    const canonicalPiPackageJsonPath = await requiredPinnedRegularFile(join(piPackageRoot, "package.json"), "Pinned Pi package metadata");
    const piImageModulePaths = await Promise.all(PI_IMAGE_MODULES.map((module) => requiredPinnedRegularFile(join(piPackageRoot, "dist", "utils", module), `Pinned Pi image pipeline module ${module}`)));
    const canonicalPhotonEntryPath = await requiredPinnedRegularFile(join(photonPackageRoot, "photon_rs.js"), "Pinned Photon image module");
    const canonicalPhotonWasmPath = await requiredPinnedRegularFile(join(photonPackageRoot, "photon_rs_bg.wasm"), "Pinned Photon WASM module");
    const canonicalPhotonPackageJsonPath = await requiredPinnedRegularFile(join(photonPackageRoot, "package.json"), "Pinned Photon package metadata");
    assertExactGraphTarget("Pinned Pi image processor", piImageProcessorPath, piImageModulePaths[0]);
    assertExactGraphTarget("Pinned Pi package metadata", piPackageJsonPath, canonicalPiPackageJsonPath);
    assertExactGraphTarget("Pinned Photon image module", photonEntryPath, canonicalPhotonEntryPath);
    assertExactGraphTarget("Pinned Photon WASM module", photonWasmPath, canonicalPhotonWasmPath);
    assertExactGraphTarget("Pinned Photon package metadata", photonPackageJsonPath, canonicalPhotonPackageJsonPath);
    const extension = extname(entryPath);
    const moduleRoot = dirname(entryPath);
    const modulePaths = await Promise.all(EXTENSION_MODULES.map((path) => realpath(join(moduleRoot, `${path}${extension}`))));
    const protocolPath = await realpath(join(dirname(fileWorkerPath), `protocol${extension}`));
    const packageRoots = [
        dirname(packageJsonPath),
        piPackageRoot,
        photonPackageRoot,
        ...sandboxRuntimeGraph.packageRoots,
    ];
    assertContainedTargets("Sandlot module graph", packageRoots[0], [...modulePaths, packageJsonPath]);
    assertContainedTargets("Pinned Pi image pipeline module", packageRoots[1], [...piImageModulePaths, piPackageJsonPath]);
    assertContainedTargets("Pinned Photon module", packageRoots[2], [photonEntryPath, photonPackageJsonPath]);
    assertContainedTargets("Pinned Photon WASM", packageRoots[2], [photonWasmPath]);
    assertContainedTargets("Pinned Sandbox Runtime entry module", dirname(sandboxRuntimePackageJsonPath), [sandboxRuntimeEntryPath, sandboxRuntimePackageJsonPath]);
    const imageResizePath = piImageModulePaths[PI_IMAGE_MODULES.indexOf("image-resize.js")];
    const expectedImageResizeWorkerPath = piImageModulePaths[PI_IMAGE_MODULES.indexOf("image-resize-worker.js")];
    const resolvedImageResizeWorkerPath = await requiredRealpath(fileURLToPath(new URL("./image-resize-worker.js", pathToFileURL(imageResizePath))), "Pinned Pi image resize worker edge");
    assertExactGraphTarget("Pinned Pi image resize worker edge", resolvedImageResizeWorkerPath, expectedImageResizeWorkerPath);
    const piPhotonImporterPath = piImageModulePaths[PI_IMAGE_MODULES.indexOf("photon.js")];
    const resolvedPhotonEntryPath = await resolvePhotonEntryFromPiImporter(piPhotonImporterPath);
    if (resolvedPhotonEntryPath !== photonEntryPath) {
        throw new Error(`Pinned Photon resolution drifted from the validated module: ${resolvedPhotonEntryPath}. ` +
            "Reinstall @earendil-works/pi-coding-agent 0.84.2 outside writable data roots.");
    }
    const resolvedPhotonWasmPath = await requiredRealpath(join(dirname(resolvedPhotonEntryPath), "photon_rs_bg.wasm"), "Pinned Photon WASM edge");
    assertExactGraphTarget("Pinned Photon WASM edge", resolvedPhotonWasmPath, photonWasmPath);
    const canonicalTargets = unique([
        ...modulePaths,
        packageJsonPath,
        nodePath,
        rgPath,
        sandboxRuntimeEntryPath,
        ...(seccompApplyPath === undefined ? [] : [seccompApplyPath]),
        ...(bwrapPath === undefined ? [] : [bwrapPath]),
        ...(socatPath === undefined ? [] : [socatPath]),
        ...additionalExecutablePaths,
        ...sandboxRuntimeGraph.packageJsonPaths,
        ...piImageModulePaths,
        piPackageJsonPath,
        photonEntryPath,
        photonWasmPath,
        photonPackageJsonPath,
    ]);
    validateImmutableTopology(input, lexicalPaths, {
        packageRoots,
        canonicalTargets,
    });
    return Object.freeze({
        trustedReadPaths: Object.freeze(unique([
            nodePath,
            fileWorkerPath,
            protocolPath,
            packageJsonPath,
            searchWorkerPath,
            rgPath,
            ...additionalExecutablePaths,
            ...(seccompApplyPath === undefined ? [] : [seccompApplyPath]),
            ...(bwrapPath === undefined ? [] : [bwrapPath]),
            ...(socatPath === undefined ? [] : [socatPath]),
        ])),
        immutablePaths: Object.freeze(unique([
            ...modulePaths,
            dirname(packageJsonPath),
            packageJsonPath,
            nodePath,
            rgPath,
            ...additionalExecutablePaths,
            ...sandboxRuntimeGraph.packageRoots,
            ...sandboxRuntimeGraph.packageJsonPaths,
            ...(seccompApplyPath === undefined ? [] : [seccompApplyPath]),
            ...(bwrapPath === undefined ? [] : [bwrapPath]),
            ...(socatPath === undefined ? [] : [socatPath]),
            dirname(piPackageJsonPath),
            ...piImageModulePaths,
            piPackageJsonPath,
            dirname(photonPackageJsonPath),
            photonEntryPath,
            photonWasmPath,
            photonPackageJsonPath,
        ])),
        rgPath,
        imageProcessorPath: piImageProcessorPath,
        seccompApplyPath,
        bwrapPath,
        socatPath,
    });
}
async function resolvePackageDependencyGraph(rootPackageJsonPath) {
    const pending = [rootPackageJsonPath];
    const visited = new Set();
    const packageJsonPaths = [];
    while (pending.length > 0) {
        const packageJsonPath = pending.pop();
        if (visited.has(packageJsonPath))
            continue;
        visited.add(packageJsonPath);
        packageJsonPaths.push(packageJsonPath);
        const parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
        if (typeof parsed !== "object" || parsed === null || typeof parsed.name !== "string") {
            throw new Error(`Sandbox Runtime dependency metadata is invalid at ${packageJsonPath}`);
        }
        const dependencies = parsed.dependencies;
        if (dependencies === undefined)
            continue;
        if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
            throw new Error(`Sandbox Runtime dependency metadata has invalid dependencies at ${packageJsonPath}`);
        }
        const resolver = createRequire(pathToFileURL(packageJsonPath));
        for (const dependencyName of Object.keys(dependencies).sort()) {
            let dependencyEntryPath;
            try {
                dependencyEntryPath = resolver.resolve(dependencyName);
            }
            catch (error) {
                throw new Error(`Pinned Sandbox Runtime dependency ${dependencyName} cannot be resolved from ${packageJsonPath}`, { cause: error });
            }
            pending.push(await findPackageJson(dependencyEntryPath, {
                requireEsm: false,
                expectedName: dependencyName,
                label: `Sandbox Runtime dependency ${dependencyName}`,
            }));
        }
    }
    return {
        packageRoots: unique(packageJsonPaths.map(dirname)),
        packageJsonPaths: unique(packageJsonPaths),
    };
}
async function resolvePhotonEntryFromPiImporter(photonImporterPath) {
    try {
        const resolved = createRequire(pathToFileURL(photonImporterPath)).resolve("@silvia-odwyer/photon-node");
        return await realpath(resolved);
    }
    catch (error) {
        throw new Error("Pinned Pi Photon importer cannot resolve its Photon dependency; reinstall @earendil-works/pi-coding-agent 0.84.2.", { cause: error });
    }
}
function assertExactGraphTarget(label, actual, expected) {
    if (actual === expected)
        return;
    throw new Error(`${label} drifted from its canonical package graph path: ${actual} (expected ${expected}). ` +
        "Reinstall @earendil-works/pi-coding-agent 0.84.2 outside writable data roots.");
}
async function requiredPinnedRegularFile(path, label) {
    let metadata;
    try {
        metadata = await lstat(path);
    }
    catch (error) {
        throw new Error(`${label} is unavailable at ${path}`, { cause: error });
    }
    if (!metadata.isFile()) {
        throw new Error(`${label} must be a regular non-symlink at its canonical package path: ${path}; ` +
            "a symlink or relocation can escape the immutable package graph. " +
            "Reinstall @earendil-works/pi-coding-agent 0.84.2 outside writable data roots.");
    }
    const canonicalPath = await requiredRealpath(path, label);
    assertExactGraphTarget(label, canonicalPath, path);
    return canonicalPath;
}
async function requiredExecutable(path, label) {
    let metadata;
    try {
        metadata = await lstat(path);
    }
    catch (error) {
        throw new Error(`${label} is unavailable at ${path}`, { cause: error });
    }
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
        throw new Error(`${label} must be an executable regular file: ${path}`);
    }
    const canonicalPath = await requiredRealpath(path, label);
    if (canonicalPath !== path) {
        throw new Error(`${label} must not be a replaceable symlink: ${path}`);
    }
    return canonicalPath;
}
async function resolvePinnedExecutable(configuredPath, fixedCandidates, label) {
    if (configuredPath !== undefined)
        return requiredExecutable(resolve(configuredPath), label);
    for (const candidate of fixedCandidates) {
        try {
            return await requiredExecutable(candidate, label);
        }
        catch (error) {
            if (!isMissingCause(error))
                throw error;
        }
    }
    throw new Error(`${label} is unavailable at every fixed system location: ${fixedCandidates.join(", ")}`);
}
function isMissingCause(error) {
    if (!(error instanceof Error) || error.cause === undefined)
        return false;
    return isMissing(error.cause);
}
function assertContainedTargets(label, packageRoot, targets) {
    const escaped = targets.find((target) => !isPathContained(packageRoot, target));
    if (escaped !== undefined) {
        throw new Error(`${label} escapes its immutable package root: ${escaped}. ` +
            "Reinstall the pinned package outside writable data roots instead of linking trusted modules externally.");
    }
}
async function findPackageJson(entryPath, options) {
    let directory = dirname(entryPath);
    const root = parse(directory).root;
    while (true) {
        const candidate = join(directory, "package.json");
        try {
            const parsed = JSON.parse(await readFile(candidate, "utf8"));
            const metadata = parsed;
            if (typeof parsed === "object" && parsed !== null &&
                (!options.requireEsm || metadata.type === "module") &&
                (options.expectedName === undefined || metadata.name === options.expectedName) &&
                (options.expectedVersion === undefined || metadata.version === options.expectedVersion)) {
                return realpath(candidate);
            }
        }
        catch (error) {
            if (!isMissing(error) && !(error instanceof SyntaxError))
                throw error;
        }
        if (directory === root)
            break;
        directory = dirname(directory);
    }
    const version = options.expectedVersion === undefined ? "" : ` at exact version ${options.expectedVersion}`;
    throw new Error(`${options.label}${version} is unavailable for ${entryPath}`);
}
function validateImmutableTopology(input, lexicalPaths, trusted) {
    if (input.filesystemDisabled === true) {
        throw new Error("Sandlot cannot make trusted host code immutable while filesystem restrictions are disabled. Enable filesystem policy before using Sandlot.");
    }
    const writableRoots = input.allowWritePaths.map((path) => resolve(path));
    const packageTrustRoots = unique([
        ...trusted.packageRoots,
        dirname(lexicalPaths.entryPath),
        dirname(lexicalPaths.piImageProcessorPath),
        dirname(lexicalPaths.photonEntryPath),
    ]);
    const exactTrustPaths = unique([
        ...Object.values(lexicalPaths),
        ...trusted.canonicalTargets,
        ...(input.entryAliases ?? []).map((path) => resolve(path)),
        ...(input.additionalExecutablePaths ?? []).map((path) => resolve(path)),
    ]);
    for (const writableRoot of writableRoots) {
        const packageOverlap = packageTrustRoots.find((trustRoot) => pathsOverlap(writableRoot, trustRoot));
        const exactOverlap = exactTrustPaths.find((trustPath) => isPathContained(writableRoot, trustPath));
        const overlap = packageOverlap ?? exactOverlap;
        if (overlap !== undefined) {
            throw new Error(`Sandlot cannot make trusted host code immutable: ${overlap} overlaps filesystem.allowWrite ${writableRoot}. ` +
                "Move/install Sandlot and Pi outside writable data roots or narrow filesystem.allowWrite.");
        }
    }
}
function pathsOverlap(left, right) {
    return isPathContained(left, right) || isPathContained(right, left);
}
async function requiredRealpath(path, label) {
    try {
        return await realpath(path);
    }
    catch (error) {
        throw new Error(`${label} is unavailable at ${path}`, { cause: error });
    }
}
function unique(values) {
    return [...new Set(values)];
}
function isMissing(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
