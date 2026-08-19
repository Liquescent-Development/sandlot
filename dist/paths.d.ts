export declare function isPathContained(parent: string, child: string): boolean;
/**
 * Resolve a policy path without treating a future filesystem target as an
 * error. Existing components are dereferenced through realpath; the lexical
 * suffix below the nearest existing ancestor is retained and cannot climb out
 * of that canonical ancestor.
 */
export declare function canonicalizePolicyPath(path: string, cwd: string): Promise<string>;
