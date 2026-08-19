import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeState } from "./runtime.js";

const PROTECTED_TOOLS = new Set(["bash", "read", "write", "edit", "ls", "find", "grep"]);

export interface GuardInput {
  readonly toolName: string;
  readonly state: RuntimeState;
  readonly tools: readonly ToolInfo[];
  /** Canonical Sandlot entry-module source supplied by src/index.ts. */
  readonly sandlotSourcePath: string;
  readonly trustedCustomTools: readonly string[];
}

export type GuardDecision =
  | { block: false }
  | { block: true; reason: string };

export function evaluateToolCall(input: GuardInput): GuardDecision {
  if (input.state === "disabled-by-user") return { block: false };
  if (input.state !== "ready") return { block: true, reason: `Sandlot is ${input.state}` };

  const tool = input.tools.find((candidate) => candidate.name === input.toolName);
  if (tool === undefined) return { block: true, reason: `Tool is not registered: ${input.toolName}` };

  if (PROTECTED_TOOLS.has(input.toolName) && !hasSandlotOwnership(tool.sourceInfo.path, input.sandlotSourcePath)) {
    return { block: true, reason: `Sandlot ownership check failed for ${input.toolName}` };
  }

  const trustedCustomTools = new Set(input.trustedCustomTools);
  if (tool.sourceInfo.source !== "builtin" && !PROTECTED_TOOLS.has(input.toolName) && !trustedCustomTools.has(input.toolName)) {
    return { block: true, reason: `Custom tool is not trusted: ${input.toolName}` };
  }

  return { block: false };
}

export function assertProtectedOwnership(tools: readonly ToolInfo[], sourcePath: string): void {
  for (const name of PROTECTED_TOOLS) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined || !hasSandlotOwnership(tool.sourceInfo.path, sourcePath)) {
      throw new Error(`Sandlot ownership check failed for ${name}`);
    }
  }
}

/** Preserve Pi's lexical extension spelling so writable symlink aliases can be rejected. */
export function protectedToolSourcePaths(tools: readonly ToolInfo[]): string[] {
  return [...new Set(tools
    .filter((tool) => PROTECTED_TOOLS.has(tool.name))
    .map((tool) => tool.sourceInfo.path))];
}

function hasSandlotOwnership(toolSourcePath: string, sandlotSourcePath: string): boolean {
  const toolSource = canonicalSource(toolSourcePath);
  const sandlotSource = canonicalSource(sandlotSourcePath);
  return toolSource !== undefined && sandlotSource !== undefined && toolSource === sandlotSource;
}

function canonicalSource(sourcePath: string): string | undefined {
  let resolved: string;
  try {
    resolved = sourcePath.startsWith("file:") ? fileURLToPath(sourcePath) : resolve(sourcePath);
  } catch {
    return undefined;
  }

  try {
    return realpathSync.native(resolved);
  } catch {
    return undefined;
  }
}
