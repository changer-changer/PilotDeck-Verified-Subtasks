/**
 * Opt-in host-side artifact acceptance validators.
 *
 * An operator opts in by pointing `PILOTDECK_ACCEPTANCE_CONFIG` at an absolute
 * JSON manifest describing, per project root, named validators that compare a
 * workspace artifact file against host-expected JSON data. The manifest is
 * loaded and snapshotted (deep-frozen) exactly once when the host constructs
 * its registry; later edits to the manifest cannot weaken running checks.
 *
 * Security posture:
 * - The manifest is trusted host configuration, not model input. No model- or
 *   manifest-supplied command, script, or checker string is ever executed;
 *   the only operation is a bounded read of the configured artifact file.
 * - Validators bind to the EXACT canonical project root (never child
 *   projects) and re-verify that the artifact realpath stays inside the root.
 * - Reads are bounded (<= 1 MiB, ordinary files only, opened non-blocking so
 *   a FIFO cannot stall the host) and fully abortable.
 * - Load failures throw sanitized structural errors and never echo manifest
 *   contents.
 */
import { constants as fsConstants, openSync, closeSync, fstatSync, readSync, realpathSync, statSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { isAbsolute, join as joinPath, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AcceptanceIssue, SubtaskValidator, SubtaskValidators } from "./types.js";

export const ACCEPTANCE_CONFIG_ENV = "PILOTDECK_ACCEPTANCE_CONFIG";

const MANIFEST_LIMIT_BYTES = 65_536;
const MAX_PROJECTS = 16;
const MAX_VALIDATORS_PER_PROJECT = 32;
const ARTIFACT_LIMIT_BYTES = 1_048_576;
const VALIDATOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DESCRIPTOR_BUDGET_CHARS = 600;

/** Frozen per-validator manifest entry. `expected` may be any JSON value. */
export type ArtifactValidatorSpec = { readonly file: string } & (
  | { readonly expected: unknown; readonly matchClaimOnly?: never }
  | { readonly matchClaimOnly: true; readonly expected?: never }
);
/** canonical project root -> validator id -> spec. Frozen at load time. */
export type ArtifactAcceptanceSnapshot = Readonly<Record<string, Readonly<Record<string, ArtifactValidatorSpec>>>>;
/** Returns the validators bound to the EXACT given project root ({}` when none apply). */
export type ArtifactAcceptanceResolver = (projectRoot: string) => SubtaskValidators;

function invalid(reason: string): never {
  throw new Error(`Invalid ${ACCEPTANCE_CONFIG_ENV} manifest: ${reason}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function withinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return Object.freeze(value!);
}

/** Canonical realpath of an existing directory, else `undefined`. */
function canonicalDirectory(path: string): string | undefined {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

function validateRelativeFile(file: unknown, where: string): asserts file is string {
  if (typeof file !== "string" || file.length === 0 || file.length > 1024 || file.includes("\0")) {
    invalid(`${where}: file must be a nonempty relative path string`);
  }
  if (isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file) || file.includes("\\")) {
    invalid(`${where}: file must be a relative path without drive or backslash separators`);
  }
  const segments = file.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    invalid(`${where}: file must not contain empty, "." or ".." segments`);
  }
}

function parseManifest(rawText: string): ArtifactAcceptanceSnapshot {
  if (Buffer.byteLength(rawText, "utf8") > MANIFEST_LIMIT_BYTES) {
    invalid(`manifest exceeds ${MANIFEST_LIMIT_BYTES} bytes`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(rawText);
  } catch {
    invalid("manifest is not valid JSON");
  }
  const stack: Array<[unknown, number]> = [[doc, 0]];
  let nodes = 0;
  while (stack.length) {
    const [value, depth] = stack.pop()!;
    if (++nodes > 8192 || depth > 64) invalid("manifest complexity limit exceeded");
    if (value && typeof value === "object") for (const child of Object.values(value)) stack.push([child, depth + 1]);
  }
  if (!isPlainObject(doc)) invalid("manifest must be a JSON object");
  for (const key of Object.keys(doc)) {
    if (key !== "version" && key !== "projects") invalid(`unknown top-level field at "${key}"`);
  }
  if (doc.version !== 1) invalid("version must be 1");
  if (!Array.isArray(doc.projects)) invalid("projects must be an array");
  if (doc.projects.length > MAX_PROJECTS) invalid(`projects must contain at most ${MAX_PROJECTS} entries`);

  const snapshot: Record<string, Record<string, ArtifactValidatorSpec>> = {};
  doc.projects.forEach((entry, projectIndex) => {
    const where = `projects[${projectIndex}]`;
    if (!isPlainObject(entry)) invalid(`${where} must be an object`);
    for (const key of Object.keys(entry)) {
      if (key !== "root" && key !== "validators") invalid(`${where}: unknown field "${key}"`);
    }
    const root = entry.root;
    if (typeof root !== "string" || root.length === 0 || root.includes("\0") || !isAbsolute(root)) {
      invalid(`${where}.root must be an absolute path to an existing directory`);
    }
    const rootReal = canonicalDirectory(root);
    if (!rootReal) invalid(`${where}.root must be an existing directory`);
    if (own(snapshot, rootReal!)) invalid(`${where}.root duplicates an already listed project root`);

    const validators = entry.validators;
    if (!isPlainObject(validators)) invalid(`${where}.validators must be an object`);
    const ids = Object.keys(validators);
    if (ids.length > MAX_VALIDATORS_PER_PROJECT) {
      invalid(`${where}.validators must contain at most ${MAX_VALIDATORS_PER_PROJECT} entries`);
    }
    const specs: Record<string, ArtifactValidatorSpec> = {};
    for (const id of ids) {
      if (!VALIDATOR_ID_PATTERN.test(id)) {
        invalid(`${where}.validators: validator id must match ${VALIDATOR_ID_PATTERN.source} (at most 64 chars)`);
      }
      const specWhere = `${where}.validators["${id}"]`;
      const spec = validators[id];
      if (!isPlainObject(spec)) invalid(`${specWhere} must be an object`);
      for (const key of Object.keys(spec)) {
        if (key !== "file" && key !== "expected" && key !== "matchClaimOnly") invalid(`${specWhere}: unknown field "${key}"`);
      }
      validateRelativeFile(spec.file, `${specWhere}`);
      if (own(spec, "matchClaimOnly") && (spec.matchClaimOnly !== true || own(spec, "expected"))) invalid(`${specWhere}: matchClaimOnly must be true and cannot coexist with expected`);
      if (!own(spec, "expected") && spec.matchClaimOnly !== true) invalid(`${specWhere}: expected or explicit matchClaimOnly: true is required`);
      specs[id] = spec.matchClaimOnly === true
        ? deepFreeze({ file: spec.file as string, matchClaimOnly: true as const })
        : deepFreeze({ file: spec.file as string, expected: spec.expected });
    }
    snapshot[rootReal!] = deepFreeze(specs);
  });
  return deepFreeze(snapshot);
}

type BoundedRead =
  | { kind: "ok"; content: Buffer }
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "not-file" }
  | { kind: "too-large" }
  | { kind: "escape" };

/** Read through an owned descriptor, bounded to limit + 1 so growth cannot hide trailing bytes. */
async function readBoundedArtifact(absolutePath: string, rootReal: string, signal?: AbortSignal): Promise<BoundedRead> {
  signal?.throwIfAborted();
  let opened: string;
  try { opened = realpathSync(absolutePath); }
  catch { return { kind: "missing" }; }
  if (!withinRoot(opened, rootReal)) return { kind: "escape" };
  let handle;
  try {
    handle = await openFile(opened, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    signal?.throwIfAborted();
    return { kind: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    signal?.throwIfAborted();
    const stats = await handle.stat();
    if (!stats.isFile()) return { kind: "not-file" };
    if (stats.size > ARTIFACT_LIMIT_BYTES) return { kind: "too-large" };
    const buffer = Buffer.allocUnsafe(ARTIFACT_LIMIT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    signal?.throwIfAborted();
    if (offset > ARTIFACT_LIMIT_BYTES) return { kind: "too-large" };
    return { kind: "ok", content: buffer.subarray(0, offset) };
  } catch (error) {
    signal?.throwIfAborted();
    return { kind: "unreadable" };
  } finally { await handle.close(); }
}

/**
 * Budget-capped JSON preview. Never materializes a huge string, even for
 * megabyte-scale saved artifacts: output stops as soon as the budget is hit.
 */
function boundedText(value: unknown, budget = DESCRIPTOR_BUDGET_CHARS): string {
  let out = "";
  let stopped = false;
  const visit = (v: unknown, depth: number): void => {
    if (stopped || out.length >= budget) {
      stopped = true;
      return;
    }
    if (v === null || typeof v === "number" || typeof v === "boolean") {
      out += JSON.stringify(v);
      return;
    }
    if (typeof v === "string") {
      const remaining = budget - out.length;
      const encoded = JSON.stringify(v);
      if (encoded.length <= remaining) {
        out += encoded;
      } else {
        out += `${encoded.slice(0, Math.max(1, remaining - 2))}…"`;
        stopped = true;
      }
      return;
    }
    if (depth > 12) {
      out += "…";
      stopped = true;
      return;
    }
    if (Array.isArray(v)) {
      out += "[";
      for (let index = 0; index < v.length; index++) {
        if (out.length >= budget) {
          stopped = true;
          break;
        }
        if (index > 0) out += ",";
        visit(v[index], depth + 1);
      }
      out += stopped || out.length >= budget ? "…]" : "]";
      return;
    }
    if (isPlainObject(v)) {
      out += "{";
      let first = true;
      for (const [key, item] of Object.entries(v)) {
        if (out.length >= budget) {
          stopped = true;
          break;
        }
        if (!first) out += ",";
        first = false;
        out += `${JSON.stringify(key)}:`;
        visit(item, depth + 1);
      }
      out += stopped || out.length >= budget ? "…}" : "}";
      return;
    }
    out += `"${String(v).slice(0, 40)}"`;
  };
  try {
    visit(value, 0);
  } catch {
    return "[unserializable value]";
  }
  return out.length > budget ? `${out.slice(0, budget)}…` : out;
}

function createArtifactValidator(spec: ArtifactValidatorSpec, rootReal: string): SubtaskValidator {
  const absolutePath = joinPath(rootReal, spec.file);
  return async (context): Promise<AcceptanceIssue[]> => {
    context.signal?.throwIfAborted();
    const value = context.value;
    if (!isPlainObject(value) || typeof value.artifact !== "string" || !own(value, "result")) {
      return [{
        path: "$",
        code: "artifact_claim",
        message: `Final value must be shaped { "artifact": "<filename>", "result": <data> }; this validator checks the saved ${spec.file} JSON`,
      }];
    }
    if (value.artifact !== spec.file) {
      return [{
        path: "$.artifact",
        code: "artifact_claim_mismatch",
        message: `Claimed artifact filename does not match; this validator checks ${spec.file}`,
      }];
    }
    const read = await readBoundedArtifact(absolutePath, rootReal, context.signal);
    switch (read.kind) {
      case "missing":
        return [{ path: "$", code: "artifact_missing", message: `Artifact file ${spec.file} is missing from the workspace` }];
      case "escape":
        return [{ path: "$", code: "artifact_escape", message: `Artifact path escapes the workspace root; refused` }];
      case "not-file":
        return [{ path: "$", code: "artifact_invalid", message: `Artifact ${spec.file} is not an ordinary file` }];
      case "too-large":
        return [{ path: "$", code: "artifact_too_large", message: `Artifact ${spec.file} exceeds the 1 MiB acceptance read limit` }];
      case "unreadable":
        return [{ path: "$", code: "artifact_unreadable", message: `Artifact ${spec.file} could not be read` }];
    }
    let saved: unknown;
    try {
      saved = JSON.parse(read.content.toString("utf8"));
    } catch {
      return [{ path: "$", code: "artifact_invalid_json", message: `Artifact ${spec.file} does not contain valid JSON` }];
    }
    if (spec.matchClaimOnly !== true && !isDeepStrictEqual(saved, spec.expected)) {
      return [{
        path: "$",
        code: "artifact_content_mismatch",
        message: `Saved ${spec.file} content differs from the host-expected value. Expected: ${boundedText(spec.expected)}; actual: ${boundedText(saved)}`,
      }];
    }
    if (!isDeepStrictEqual(value.result, saved)) {
      return [{
        path: "$.result",
        code: "artifact_claim_mismatch",
        message: `Claimed result does not equal the saved ${spec.file} content. Saved: ${boundedText(saved)}; claimed: ${boundedText(value.result)}`,
      }];
    }
    return [];
  };
}

/**
 * Load the opted-in manifest and return a per-project resolver, or
 * `undefined` when no config path is configured (legacy behavior).
 * Throws a sanitized error for an invalid opted-in manifest. The returned
 * resolver reads only the in-memory snapshot — never the manifest again.
 */
export function loadAcceptanceArtifactResolver(configPath?: string): ArtifactAcceptanceResolver | undefined {
  const path = configPath?.trim();
  if (!path) return undefined;
  if (!isAbsolute(path)) invalid("config path must be absolute");
  let rawText: string;
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0));
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > MANIFEST_LIMIT_BYTES) invalid("manifest must be an ordinary file of at most 64 KiB");
    const buffer = Buffer.allocUnsafe(MANIFEST_LIMIT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset > MANIFEST_LIMIT_BYTES) invalid("manifest exceeds 64 KiB");
    rawText = buffer.subarray(0, offset).toString("utf8");
  } catch { invalid("manifest must be a readable ordinary file of at most 64 KiB"); }
  finally { if (fd !== undefined) closeSync(fd); }
  const snapshot = parseManifest(rawText!);
  return (projectRoot: string): SubtaskValidators => {
    const canonical = canonicalDirectory(projectRoot);
    const specs = canonical ? snapshot[canonical] : undefined;
    if (!specs) return Object.freeze({});
    const registry: Record<string, SubtaskValidator> = {};
    for (const [id, spec] of Object.entries(specs)) {
      registry[id] = createArtifactValidator(spec, canonical!);
    }
    return Object.freeze(registry);
  };
}
