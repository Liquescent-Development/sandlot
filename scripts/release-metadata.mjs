import { fstatSync, fsyncSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_VERSION_BYTES = 128;
const MAX_CHANGELOG_BYTES = 64 * 1024;
const PLACEHOLDER = /\b(?:TBD|TODO|FIXME)\b/i;

export function parseStableVersion(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_VERSION_BYTES || !STABLE_VERSION.test(value)) {
    throw new Error("release version must be an exact stable semantic version");
  }
  return value;
}

export function extractReleaseNotes(markdown, version, maxBytes = MAX_CHANGELOG_BYTES) {
  const requestedVersion = parseStableVersion(version);
  if (typeof markdown !== "string" || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("release notes input is invalid");
  }
  if (Buffer.byteLength(markdown, "utf8") > maxBytes) {
    throw new Error("changelog exceeds the release notes size limit");
  }

  const escapedVersion = requestedVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headings = [...markdown.matchAll(/^##(?:[ \t]|$)[^\r\n]*\r?$/gm)];
  const matching = headings.filter((heading) => new RegExp(`^## \\[${escapedVersion}\\](?:[ \\t]|$)`).test(heading[0]));
  if (matching.length !== 1) {
    throw new Error("changelog must contain exactly one matching release heading");
  }

  const heading = matching[0];
  const releaseHeading = new RegExp(`^## \\[${escapedVersion}\\] - (\\d{4}-\\d{2}-\\d{2})[ \\t]*\\r?$`).exec(heading[0]);
  if (releaseHeading === null) {
    throw new Error("changelog release heading is invalid");
  }
  if (!isValidDate(releaseHeading[1])) {
    throw new Error("changelog release date is invalid");
  }

  const nextHeading = headings.find((candidate) => candidate.index > heading.index);
  let bodyStart = heading.index + heading[0].length;
  if (markdown.startsWith("\r\n", bodyStart)) bodyStart += 2;
  else if (markdown.startsWith("\n", bodyStart)) bodyStart += 1;
  const bodyEnd = nextHeading?.index ?? markdown.length;
  const notes = `${markdown.slice(bodyStart, bodyEnd).replace(/^\r?\n/, "").replace(/(?:\r?\n)+$/, "")}\n`;

  if (!notes.trim() || Buffer.byteLength(notes, "utf8") > maxBytes) {
    throw new Error("changelog release notes are empty or exceed the size limit");
  }
  if (PLACEHOLDER.test(notes)) {
    throw new Error("changelog release notes contain a placeholder");
  }
  return notes;
}

export function validateReleaseMetadata(input) {
  if (!isPlainObject(input) || typeof input.changelog !== "string") {
    throw new Error("release metadata input is invalid");
  }
  const version = parseStableVersion(input.version);
  const manifestVersion = ownString(input.manifest, "version", "package manifest");
  const lockfileVersion = ownString(input.lockfile, "version", "package lockfile");
  const packages = ownPlainObject(input.lockfile, "packages", "package lockfile");
  const rootPackage = ownPlainObject(packages, "", "package lockfile root package");
  const rootPackageVersion = ownString(rootPackage, "version", "package lockfile root package");

  if (manifestVersion !== version || lockfileVersion !== version || rootPackageVersion !== version) {
    throw new Error("package metadata versions must match the release version");
  }
  return { version, tag: `v${version}`, notes: extractReleaseNotes(input.changelog, version) };
}

async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArguments(args);
    const [manifest, lockfile, changelog] = await Promise.all([
      readJson("package.json"),
      readJson("package-lock.json"),
      readText("CHANGELOG.md"),
    ]);
    const metadata = validateReleaseMetadata({
      version: options.version,
      manifest,
      lockfile,
      changelog,
    });
    const notesInfo = validateOutputDescriptor(options.notesFd);
    const metadataInfo = validateOutputDescriptor(options.metadataFd);
    if (notesInfo.dev === metadataInfo.dev && notesInfo.ino === metadataInfo.ino) {
      throw new Error("release output descriptors must reference distinct files");
    }
    writeOutputs(
      options.notesFd,
      options.metadataFd,
      metadata.notes,
      `${JSON.stringify({ version: metadata.version, tag: metadata.tag, notesFile: options.notesFile }, null, 2)}\n`,
    );
  } catch {
    process.stderr.write("release metadata validation failed\n");
    process.exitCode = 1;
  }
}

function parseArguments(args) {
  if (args.length !== 8) throw new Error("expected version, two output descriptors, and a notes filename");
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const [name, value] = [args[index], args[index + 1]];
    if ((name !== "--version" && name !== "--notes-fd" && name !== "--metadata-fd" && name !== "--notes-file") || typeof value !== "string" || Object.hasOwn(options, name)) {
      throw new Error("expected version, two output descriptors, and a notes filename");
    }
    options[name] = value;
  }
  if (!Object.hasOwn(options, "--version") || !Object.hasOwn(options, "--notes-fd") || !Object.hasOwn(options, "--metadata-fd") || !Object.hasOwn(options, "--notes-file")) {
    throw new Error("expected version, two output descriptors, and a notes filename");
  }
  return {
    version: options["--version"],
    notesFd: parseDescriptor(options["--notes-fd"]),
    metadataFd: parseDescriptor(options["--metadata-fd"]),
    notesFile: parseNotesFile(options["--notes-file"]),
  };
}

function parseDescriptor(value) {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("release output descriptor is invalid");
  const descriptor = Number(value);
  if (!Number.isSafeInteger(descriptor)) throw new Error("release output descriptor is invalid");
  return descriptor;
}

function parseNotesFile(requestedPath) {
  if (
    typeof requestedPath !== "string"
    || requestedPath.length === 0
    || isAbsolute(requestedPath)
    || requestedPath !== basename(requestedPath)
    || requestedPath === "."
    || requestedPath === ".."
  ) {
    throw new Error("release notes filename is invalid");
  }
  return requestedPath;
}

function validateOutputDescriptor(descriptor) {
  const info = fstatSync(descriptor);
  if (!info.isFile()) throw new Error("release output descriptor is not a regular file");
  return info;
}

function writeOutputs(notesFd, metadataFd, notes, metadata) {
  writeFileSync(notesFd, notes, "utf8");
  fsyncSync(notesFd);
  writeFileSync(metadataFd, metadata, "utf8");
  fsyncSync(metadataFd);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("release manifest JSON is invalid");
  }
}

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new Error("release changelog is unavailable");
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function ownString(object, property, label) {
  if (!isPlainObject(object) || !Object.hasOwn(object, property) || typeof object[property] !== "string") {
    throw new Error(`${label} version is invalid`);
  }
  return object[property];
}

function ownPlainObject(object, property, label) {
  if (!isPlainObject(object) || !Object.hasOwn(object, property) || !isPlainObject(object[property])) {
    throw new Error(`${label} is invalid`);
  }
  return object[property];
}

function isValidDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
