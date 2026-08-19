import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { SandlotConfigError } from "./config.js";

export function isPathContained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Resolve a policy path without treating a future filesystem target as an
 * error. Existing components are dereferenced through realpath; the lexical
 * suffix below the nearest existing ancestor is retained and cannot climb out
 * of that canonical ancestor.
 */
export async function canonicalizePolicyPath(path: string, cwd: string): Promise<string> {
  if (path.length === 0) throw new SandlotConfigError("policy path", "path cannot be empty");

  let candidate = isAbsolute(path) ? path : `${cwd}${sep}${path}`;
  const missingComponents: string[] = [];

  while (true) {
    try {
      const ancestor = await realpath(candidate);
      const canonical = normalize(join(ancestor, ...missingComponents));
      if (!isPathContained(ancestor, canonical)) {
        throw new SandlotConfigError("policy path", `path ${path} escapes its resolved ancestor`);
      }
      return canonical;
    } catch (error: unknown) {
      if (error instanceof SandlotConfigError) throw error;
      if (!isNotFound(error)) {
        throw new SandlotConfigError("policy path", `could not canonicalize ${path}`, { cause: error });
      }
      const status = await lstatIfPresent(candidate, path);
      if (status?.isSymbolicLink()) {
        throw new SandlotConfigError("policy path", `broken symlink in ${path}`);
      }

      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new SandlotConfigError("policy path", `could not find an existing ancestor for ${path}`, { cause: error });
      }
      missingComponents.unshift(candidate.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      candidate = parent;
    }
  }
}

async function lstatIfPresent(path: string, originalPath: string) {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    throw new SandlotConfigError("policy path", `could not inspect ${originalPath}`, { cause: error });
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
