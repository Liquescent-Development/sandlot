import { expect } from "vitest";
import { FileWorkerError } from "../../dist/helpers/file-worker.js";

const WRITE_DENIAL_CODES = process.platform === "linux"
  ? (["EACCES", "EPERM", "EROFS"] as const)
  : (["EPERM"] as const);
// Bubblewrap may hide a denied directory behind tmpfs, so a host-present
// credential can surface as ENOENT inside Linux. Callers also verify host bytes.
const READ_DENIAL_CODES = process.platform === "linux"
  ? (["EACCES", "EPERM", "ENOENT"] as const)
  : (["EACCES", "EPERM"] as const);

export async function expectFileWorkerDenial(
  operation: Promise<unknown>,
  path: string,
  mode: "read" | "write",
): Promise<FileWorkerError> {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(FileWorkerError);
  const workerFailure = failure as FileWorkerError;
  expect(mode === "read" ? READ_DENIAL_CODES : WRITE_DENIAL_CODES).toContain(workerFailure.code);
  expect(workerFailure.message).toContain(path);
  return workerFailure;
}
