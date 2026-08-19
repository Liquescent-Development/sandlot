import { randomUUID } from "node:crypto";
import { chmod as nodeChmod, lstat as nodeLstat, mkdir as nodeMkdir, readdir as nodeReaddir, rmdir as nodeRmdir, unlink as nodeUnlink, } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
const PRIVATE_MODE = 0o700;
const NODE_FILESYSTEM = Object.freeze({
    async mkdir(path, mode) {
        await nodeMkdir(path, { mode });
    },
    chmod: nodeChmod,
    lstat: nodeLstat,
    async readdir(path) {
        return nodeReaddir(path, { withFileTypes: true });
    },
    rmdir: nodeRmdir,
    unlink: nodeUnlink,
});
export async function createSandlotSessionTemporaryDirectory(options = {}) {
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
        const rootIdentity = await createPrivate(filesystem, root, uid, "Sandlot temporary root", false, (identity) => rollback.add(root, identity, "Sandlot temporary root", "empty", []));
        const rootGuard = {
            path: root,
            identity: rootIdentity,
            label: "Sandlot temporary root",
        };
        const userIdentity = await createPrivate(filesystem, user, uid, "Sandlot temporary uid directory", false, (identity) => rollback.add(user, identity, "Sandlot temporary uid directory", "empty", [rootGuard]));
        const userGuard = {
            path: user,
            identity: userIdentity,
            label: "Sandlot temporary uid directory",
        };
        const sessionIdentity = await createPrivate(filesystem, session, uid, "Sandlot temporary session directory", true, (identity) => rollback.add(session, identity, "Sandlot temporary session directory", "tree", [rootGuard, userGuard]));
        const cleanupAuthority = new CleanupAuthority(filesystem, uid);
        cleanupAuthority.add(session, sessionIdentity, "Sandlot temporary session directory", "tree", [rootGuard, userGuard]);
        const directory = Object.freeze({
            path: session,
            cleanup: async () => cleanupAuthority.cleanup(),
        });
        return Object.freeze({ ok: true, directory });
    }
    catch (error) {
        const creationError = asError(error);
        try {
            await rollback.cleanup();
            return Object.freeze({ ok: false, error: creationError });
        }
        catch (rollbackError) {
            return Object.freeze({
                ok: false,
                error: new AggregateError([creationError, asError(rollbackError)], "Sandlot temporary directory creation and rollback both failed"),
                cleanupAuthority: rollback,
            });
        }
    }
}
class CleanupAuthority {
    filesystem;
    uid;
    #actions = [];
    constructor(filesystem, uid) {
        this.filesystem = filesystem;
        this.uid = uid;
    }
    add(path, identity, label, kind, guards) {
        this.#actions.push({ path, identity, label, kind, guards });
    }
    async cleanup() {
        while (this.#actions.length > 0) {
            const action = this.#actions[this.#actions.length - 1];
            for (const guard of action.guards) {
                await verifySame(this.filesystem, guard.path, guard.identity, guard.label);
            }
            if (action.kind === "tree") {
                await removeTree(this.filesystem, action.path, action.identity, this.uid);
            }
            else {
                await verifySame(this.filesystem, action.path, action.identity, action.label);
                await this.filesystem.rmdir(action.path);
            }
            this.#actions.pop();
        }
    }
}
function requiredUid() {
    const uid = process.getuid?.();
    if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
        throw new Error("Sandlot requires a numeric host uid");
    }
    return uid;
}
async function createPrivate(filesystem, path, uid, label, exclusive, onCreated) {
    let adopted = false;
    const adopt = (identity) => {
        if (adopted)
            return;
        adopted = true;
        onCreated(identity);
    };
    try {
        await filesystem.mkdir(path, PRIVATE_MODE);
    }
    catch (error) {
        if (!isExists(error))
            throw new Error(`Could not create ${label}`, { cause: error });
        const identity = await verifyPrivate(filesystem, path, uid, label);
        if (exclusive)
            throw new Error(`${label} already exists`);
        return identity;
    }
    try {
        await filesystem.chmod(path, PRIVATE_MODE);
    }
    catch (error) {
        const identity = await captureOwnedIdentity(filesystem, path, uid);
        if (identity === undefined)
            throw error;
        adopt(identity);
        throw error;
    }
    let status;
    try {
        status = await filesystem.lstat(path);
    }
    catch (error) {
        const identity = await captureOwnedIdentity(filesystem, path, uid);
        if (identity === undefined)
            throw error;
        adopt(identity);
        throw error;
    }
    const identity = ownedIdentity(status, uid);
    if (identity !== undefined)
        adopt(identity);
    validatePrivateStatus(status, uid, label);
    return identity;
}
async function captureOwnedIdentity(filesystem, path, uid) {
    try {
        return ownedIdentity(await filesystem.lstat(path), uid);
    }
    catch {
        return undefined;
    }
}
function ownedIdentity(status, uid) {
    if (status.isSymbolicLink() || !status.isDirectory() || status.uid !== uid)
        return undefined;
    return { dev: status.dev, ino: status.ino, uid: status.uid };
}
async function verifyPrivate(filesystem, path, uid, label) {
    const status = await filesystem.lstat(path);
    validatePrivateStatus(status, uid, label);
    return { dev: status.dev, ino: status.ino, uid: status.uid };
}
function validatePrivateStatus(status, uid, label) {
    if (status.isSymbolicLink())
        throw new Error(`${label} is a symbolic link`);
    if (!status.isDirectory())
        throw new Error(`${label} is not a directory`);
    if (status.uid !== uid)
        throw new Error(`${label} has wrong ownership`);
    if ((status.mode & 0o7777) !== PRIVATE_MODE)
        throw new Error(`${label} has unsafe permissions`);
}
async function verifySame(filesystem, path, expected, label) {
    const actual = await verifyPrivate(filesystem, path, expected.uid, label);
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
        throw new Error(`${label} identity changed; refusing cleanup`);
    }
}
async function removeTree(filesystem, path, expected, uid, privateBoundary = true) {
    if (privateBoundary) {
        await verifySame(filesystem, path, expected, "Sandlot temporary session directory");
    }
    else {
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
        await removeTree(filesystem, child, { dev: status.dev, ino: status.ino, uid: status.uid }, uid, false);
    }
    if (privateBoundary) {
        await verifySame(filesystem, path, expected, "Sandlot temporary session directory");
    }
    else {
        await verifyOwnedDirectorySame(filesystem, path, expected, uid);
    }
    await filesystem.rmdir(path);
}
async function verifyOwnedDirectorySame(filesystem, path, expected, uid) {
    const status = await filesystem.lstat(path);
    if (status.isSymbolicLink() || !status.isDirectory() || status.uid !== uid) {
        throw new Error(`Sandlot temporary session child is unsafe: ${path}`);
    }
    if (status.dev !== expected.dev || status.ino !== expected.ino) {
        throw new Error(`Sandlot temporary session child identity changed; refusing cleanup: ${path}`);
    }
}
function asError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
function isExists(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
