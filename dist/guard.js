import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const PROTECTED_TOOLS = new Set(["bash", "read", "write", "edit", "ls", "find", "grep"]);
export function evaluateToolCall(input) {
    if (input.state === "disabled-by-user")
        return { block: false };
    if (input.state !== "ready")
        return { block: true, reason: `Sandlot is ${input.state}` };
    const tool = input.tools.find((candidate) => candidate.name === input.toolName);
    if (tool === undefined)
        return { block: true, reason: `Tool is not registered: ${input.toolName}` };
    if (PROTECTED_TOOLS.has(input.toolName) && !hasSandlotOwnership(tool.sourceInfo.path, input.sandlotSourcePath)) {
        return { block: true, reason: `Sandlot ownership check failed for ${input.toolName}` };
    }
    const trustedCustomTools = new Set(input.trustedCustomTools);
    if (tool.sourceInfo.source !== "builtin" && !PROTECTED_TOOLS.has(input.toolName) && !trustedCustomTools.has(input.toolName)) {
        return { block: true, reason: `Custom tool is not trusted: ${input.toolName}` };
    }
    return { block: false };
}
export function assertProtectedOwnership(tools, sourcePath) {
    for (const name of PROTECTED_TOOLS) {
        const tool = tools.find((candidate) => candidate.name === name);
        if (tool === undefined || !hasSandlotOwnership(tool.sourceInfo.path, sourcePath)) {
            throw new Error(`Sandlot ownership check failed for ${name}`);
        }
    }
}
/** Preserve Pi's lexical extension spelling so writable symlink aliases can be rejected. */
export function protectedToolSourcePaths(tools) {
    return [...new Set(tools
            .filter((tool) => PROTECTED_TOOLS.has(tool.name))
            .map((tool) => tool.sourceInfo.path))];
}
function hasSandlotOwnership(toolSourcePath, sandlotSourcePath) {
    const toolSource = canonicalSource(toolSourcePath);
    const sandlotSource = canonicalSource(sandlotSourcePath);
    return toolSource !== undefined && sandlotSource !== undefined && toolSource === sandlotSource;
}
function canonicalSource(sourcePath) {
    let resolved;
    try {
        resolved = sourcePath.startsWith("file:") ? fileURLToPath(sourcePath) : resolve(sourcePath);
    }
    catch {
        return undefined;
    }
    try {
        return realpathSync.native(resolved);
    }
    catch {
        return undefined;
    }
}
