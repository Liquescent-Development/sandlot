import { randomUUID } from "node:crypto";
import {
  chmod as nodeChmod,
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  readdir as nodeReaddir,
  rmdir as nodeRmdir,
  unlink as nodeUnlink,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, join } from "node:path";

const PRIVATE_MODE = 0o700;

interface Identity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
}

export interface SandlotTemporaryDirectoryStatus extends Identity {
  readonly mode: number;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}

export interface SandlotTemporaryDirectoryFileSystem {
  mkdir(path: string, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<SandlotTemporaryDirectoryStatus>;
  readdir(path: string): Promise<Dirent[]>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface SandlotTemporaryDirectoryCleanupAuthority {
  cleanup(): Promise<void>;
}

export interface SandlotSessionTemporaryDirectory extends SandlotTemporaryDirectoryCleanupAuthority {
  readonly path: string;
}

export interface SandlotSessionTemporaryDirectoryOptions {
  readonly root?: string;
  readonly uid?: number;
  readonly sessionId?: string;
  /** A narrow syscall seam for deterministic validation of filesystem failures. */
  readonly filesystem?: SandlotTemporaryDirectoryFileSystem;
}

export type SandlotSessionTemporaryDirectoryCreationResult =
  | {
      readonly ok: true;
      readonly directory: SandlotSessionTemporaryDirectory;
    }
  | {
      readonly ok: false;
      readonly error: Error;
      readonly cleanupAuthority?: SandlotTemporaryDirectoryCleanupAuthority;
    };

interface CleanupAction {
  readonly path: string;
  readonly identity: Identity;
  readonly label: string;
  readonly kind: "empty" | "tree";
  readonly guards: readonly Guard[];
}

interface Guard {
  readonly path: string;
  readonly identity: Identity;
  readonly label: string;
}

const NODE_FILESYSTEM: SandlotTemporaryDirectoryFileSystem = Object.freeze({
  async mkdir(path: string, mode: number): Promise<void> {
    await nodeMkdir(path, { mode });
  },
  chmod: nodeChmod,
  lstat: nodeLstat,
  async readdir(path: string): Promise<Dirent[]> {
    return nodeReaddir(path, { withFileTypes: true });
  },
  rmdir: nodeRmdir,
  unlink: nodeUnlink,
});

export async function createSandlotSessionTemporaryDirectory(
  options: SandlotSessionTemporaryDirectoryOptions = {},
): Promise<SandlotSessionTemporaryDirectoryCreationResult> {
  const root = options.root ?? "/tmp/sandlot";
  const uid = options.uid ?? requiredUid();
  const sessionId = options.sessionId ?? randomUUID();
  if (!isAbsolute(root) || !/^[A-Za-z0-9-]+$/.test(sessionId)) {
    throw new Error("Sandlot temporary directory arguments are invalid");
  }

  const filesystem = options.filesystem ?? NODE_FILESYSTEM;
  const user = join(root, String(uid));
  const session = join(user, `session-${sessionId}`);
  const rollback = new CleanupAuthority(filesystem, uid);

  try {
    const rootIdentity = await createPrivate(
      filesystem,
      root,
      uid,
      "Sandlot temporary root",
      false,
      (identity) => rollback.add(root, identity, "Sandlot temporary root", "empty", []),
    );
    const rootGuard: Guard = {
      path: root,
      identity: rootIdentity,
      label: "Sandlot temporary root",
    };

    const userIdentity = await createPrivate(
      filesystem,
      user,
      uid,
      "Sandlot temporary uid directory",
      false,
      (identity) => rollback.add(
        user,
        identity,
        "Sandlot temporary uid directory",
        "empty",
        [rootGuard],
      ),
    );
    const userGuard: Guard = {
      path: user,
      identity: userIdentity,
      label: "Sandlot temporary uid directory",
    };

    const sessionIdentity = await createPrivate(
      filesystem,
      session,
      uid,
      "Sandlot temporary session directory",
      true,
      (identity) => rollback.add(
        session,
        identity,
        "Sandlot temporary session directory",
        "tree",
        [rootGuard, userGuard],
      ),
    );

    const cleanupAuthority = new CleanupAuthority(filesystem, uid);
    cleanupAuthority.add(
      session,
      sessionIdentity,
      "Sandlot temporary session directory",
      "tree",
      [rootGuard, userGuard],
    );
    const directory = Object.freeze({
      path: session,
      cleanup: async (): Promise<void> => cleanupAuthority.cleanup(),
    });
    return Object.freeze({ ok: true, directory });
  } catch (error: unknown) {
    const creationError = asError(error);
    try {
      await rollback.cleanup();
      return Object.freeze({ ok: false, error: creationError });
    } catch (rollbackError: unknown) {
      return Object.freeze({
        ok: false,
        error: new AggregateError(
          [creationError, asError(rollbackError)],
          "Sandlot temporary directory creation and rollback both failed",
        ),
        cleanupAuthority: rollback,
      });
    }
  }
}

class CleanupAuthority implements SandlotTemporaryDirectoryCleanupAuthority {
  readonly #actions: CleanupAction[] = [];

  constructor(
    private readonly filesystem: SandlotTemporaryDirectoryFileSystem,
    private readonly uid: number,
  ) {}

  add(
    path: string,
    identity: Identity,
    label: string,
    kind: CleanupAction["kind"],
    guards: readonly Guard[],
  ): void {
    this.#actions.push({ path, identity, label, kind, guards });
  }

  async cleanup(): Promise<void> {
    while (this.#actions.length > 0) {
      const action = this.#actions[this.#actions.length - 1]!;
      for (const guard of action.guards) {
        await verifySame(this.filesystem, guard.path, guard.identity, guard.label);
      }
      if (action.kind === "tree") {
        await removeTree(this.filesystem, action.path, action.identity, this.uid);
      } else {
        await verifySame(this.filesystem, action.path, action.identity, action.label);
        await this.filesystem.rmdir(action.path);
      }
      this.#actions.pop();
    }
  }
}

function requiredUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("Sandlot requires a numeric host uid");
  }
  return uid;
}

async function createPrivate(
  filesystem: SandlotTemporaryDirectoryFileSystem,
  path: string,
  uid: number,
  label: string,
  exclusive: boolean,
  onCreated: (identity: Identity) => void,
): Promise<Identity> {
  let adopted = false;
  const adopt = (identity: Identity): void => {
    if (adopted) return;
    adopted = true;
    onCreated(identity);
  };
  try {
    await filesystem.mkdir(path, PRIVATE_MODE);
  } catch (error: unknown) {
    if (!isExists(error)) throw new Error(`Could not create ${label}`, { cause: error });
    const identity = await verifyPrivate(filesystem, path, uid, label);
    if (exclusive) throw new Error(`${label} already exists`);
    return identity;
  }

  try {
    await filesystem.chmod(path, PRIVATE_MODE);
  } catch (error: unknown) {
    const identity = await captureOwnedIdentity(filesystem, path, uid);
    if (identity === undefined) throw error;
    adopt(identity);
    throw error;
  }
  let status: SandlotTemporaryDirectoryStatus;
  try {
    status = await filesystem.lstat(path);
  } catch (error: unknown) {
    const identity = await captureOwnedIdentity(filesystem, path, uid);
    if (identity === undefined) throw error;
    adopt(identity);
    throw error;
  }
  const identity = ownedIdentity(status, uid);
  if (identity !== undefined) adopt(identity);
  validatePrivateStatus(status, uid, label);
  return identity!;
}

async function captureOwnedIdentity(
  filesystem: SandlotTemporaryDirectoryFileSystem,
  path: string,
  uid: number,
): Promise<Identity | undefined> {
  try {
    return ownedIdentity(await filesystem.lstat(path), uid);
  } catch {
    return undefined;
  }
}

function ownedIdentity(status: SandlotTemporaryDirectoryStatus, uid: number): Identity | undefined {
  if (status.isSymbolicLink() || !status.isDirectory() || status.uid !== uid) return undefined;
  return { dev: status.dev, ino: status.ino, uid: status.uid };
}

async function verifyPrivate(
  filesystem: SandlotTemporaryDirectoryFileSystem,
  path: string,
  uid: number,
  label: string,
): Promise<Identity> {
  const status = await filesystem.lstat(path);
  validatePrivateStatus(status, uid, label);
  return { dev: status.dev, ino: status.ino, uid: status.uid };
}

function validatePrivateStatus(status: SandlotTemporaryDirectoryStatus, uid: number, label: string): void {
  if (status.isSymbolicLink()) throw new Error(`${label} is a symbolic link`);
  if (!status.isDirectory()) throw new Error(`${label} is not a directory`);
  if (status.uid !== uid) throw new Error(`${label} has wrong ownership`);
  if ((status.mode & 0o7777) !== PRIVATE_MODE) throw new Error(`${label} has unsafe permissions`);
}

async function verifySame(
  filesystem: SandlotTemporaryDirectoryFileSystem,
  path: string,
  expected: Identity,
  label: string,
): Promise<void> {
  const actual = await verifyPrivate(filesystem, path, expected.uid, label);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(`${label} identity changed; refusing cleanup`);
  }
}

async function removeTree(
  filesystem: SandlotTemporaryDirectoryFileSystem,
  path: string,
  expected: Identity,
  uid: number,
  privateBoundary = true,
): Promise<void> {
  if (privateBoundary) {
    await verifySame(filesystem, path, expected, "Sandlot temporary session directory");
  } else {
    await verifyOwnedDirectorySame(filesystem, path, expected, uid);
  }
  for (const entry of await filesystem.readdir(path)) {
    const child = join(path, entry.name);
    const status = await filesystem.lstat(child);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      await filesystem.unlink(child);
      continue;
    }
    if (status.uid !== uid) {
      throw new Error(`Sandlot temporary session child is unsafe: ${child}`);
    }
    await removeTree(
      filesystem,
      child,
      { dev: status.dev, ino: status.ino, uid: status.uid },
      uid,
      false,
    );
  }
  if (privateBoundary) {
    await verifySame(filesystem, path, expected, "Sandlot temporary session directory");
  } else {
    await verifyOwnedDirectorySame(filesystem, path, expected, uid);
  }
  await filesystem.rmdir(path);
}

async function verifyOwnedDirectorySame(
  filesystem: SandlotTemporaryDirectoryFileSystem,
  path: string,
  expected: Identity,
  uid: number,
): Promise<void> {
  const status = await filesystem.lstat(path);
  if (status.isSymbolicLink() || !status.isDirectory() || status.uid !== uid) {
    throw new Error(`Sandlot temporary session child is unsafe: ${path}`);
  }
  if (status.dev !== expected.dev || status.ino !== expected.ino) {
    throw new Error(`Sandlot temporary session child identity changed; refusing cleanup: ${path}`);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
