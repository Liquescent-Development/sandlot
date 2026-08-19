import type { SandboxViolationLike } from "./runner.js";

export interface ClassifiedSandboxViolation {
  /** Semantic operation used for presentation and equivalence deduplication. */
  readonly operation: string;
  readonly target: string;
}

const DENIAL_PATTERN = /\bdeny(?:\(\d+\))?\s+([a-z][a-z0-9_-]*)(?:\s+(.+?))?\s*$/i;

/**
 * Normalize every recognizably structured Runtime denial. A new Runtime
 * operation remains visible through the generic fallback rather than being
 * silently dropped; only the exact benign macOS probe is suppressed.
 */
export function classifySandboxViolations(
  violations: readonly SandboxViolationLike[],
): readonly ClassifiedSandboxViolation[] {
  const classified: ClassifiedSandboxViolation[] = [];
  const newestFirst: ClassifiedSandboxViolation[] = [];
  const seen = new Set<string>();
  for (const violation of [...violations].reverse()) {
    const parsed = parseViolation(violation.line);
    if (parsed === undefined || isExactBenignProbe(parsed)) continue;
    const key = `${parsed.operation}\u0000${parsed.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    newestFirst.push(parsed);
  }
  classified.push(...newestFirst.reverse());
  return classified;
}

export function formatSandboxViolations(violations: readonly SandboxViolationLike[]): string {
  return formatClassifiedSandboxViolations(classifySandboxViolations(violations));
}

export function formatClassifiedSandboxViolations(violations: readonly ClassifiedSandboxViolation[]): string {
  return violations
    .map((violation) => `Blocked by Sandlot: ${describeViolation(violation)}`)
    .join("\n");
}

function parseViolation(line: string): ClassifiedSandboxViolation | undefined {
  const match = DENIAL_PATTERN.exec(line);
  if (match?.[1] === undefined) return undefined;
  const target = (match[2] ?? "")
    .replace(/\s*\(?pid(?:=|\s+)\d+\)?\s*$/i, "")
    .trim();
  return { operation: canonicalOperation(match[1]), target };
}

function canonicalOperation(operation: string): string {
  const normalized = operation.toLowerCase();
  if (normalized === "network" || normalized === "network-outbound") return "network";
  return normalized;
}

function isExactBenignProbe(violation: ClassifiedSandboxViolation): boolean {
  return violation.operation === "sysctl-read" && violation.target === "kern.iossupportversion";
}

function describeViolation(violation: ClassifiedSandboxViolation): string {
  const operation = sanitizeViolationText(violation.operation);
  const target = sanitizeViolationText(violation.target);
  switch (violation.operation) {
    case "file-read": return `read file ${target}`;
    case "file-write": return `write file ${target}`;
    case "file-write-create": return `create file ${target}`;
    case "file-write-unlink": return `remove file ${target}`;
    case "network": return `network access ${target}`;
    case "http-request": return `HTTP request ${target}`;
    case "mach-lookup": return `Mach service lookup ${target}`;
    case "sysctl-read": return `read system setting ${target}`;
    case "sysctl-write": return `write system setting ${target}`;
    case "process-fork": return target === "" ? "fork process" : `fork process ${target}`;
    default: return target === "" ? `system call ${operation}` : `system call ${operation} ${target}`;
  }
}

function sanitizeViolationText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/</g, "[")
    .replace(/>/g, "]")
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .trim();
}
