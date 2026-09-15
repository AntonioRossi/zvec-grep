import { readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { EngineError } from "../errors.js";
import { sha256Text } from "./hash.js";
import { normalizePath } from "./path.js";

// Canonical workspace-relative paths (CRP) per
// docs/design/portable-workspace-index.md: "/" separator, NFC segments, case
// preserved from the actual directory entry, no "." or ".." segments.

const ROOT_CRP = ".";

export function makeFileId(
  workspaceIndexId: string,
  canonicalPath: string,
): string {
  return sha256Text(`${workspaceIndexId}\0${canonicalPath}`);
}

/** NFC-normalize every segment of a "/" separated relative path. */
export function canonicalFromRelative(relativePath: string): string {
  return relativePath
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .map((segment) => segment.normalize("NFC"))
    .join("/");
}

/**
 * Compute a file's CRP from its absolute path. Both inputs must be
 * comparably resolved (realpath-normalized). Returns null when the file is
 * outside the workspace.
 */
export function canonicalRelativePath(
  workspaceRoot: string,
  absolutePath: string,
): string | null {
  const relativePath = relative(
    normalizePath(workspaceRoot),
    normalizePath(absolutePath),
  );
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    return null;
  }
  return canonicalFromRelative(relativePath.split(sep).join("/"));
}

/** The CRP used for the workspace root itself in root-path configuration. */
export function workspaceRootCrp(): string {
  return ROOT_CRP;
}

/** True when the value is a structurally valid CRP (form only). */
export function isCanonicalRelativePath(value: string): boolean {
  if (value === ROOT_CRP) {
    return true;
  }
  if (value.length === 0 || value.startsWith("/") || value.endsWith("/")) {
    return false;
  }
  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 && segment !== "." && segment !== "..",
    );
}

export type CanonicalNameCollision = {
  kind: "unicode" | "case";
  directory: string;
  names: string[];
};

/** Detect NFC and case-folded collisions within one directory listing. */
export function findCanonicalNameCollisions(
  directory: string,
  names: readonly string[],
): CanonicalNameCollision[] {
  const collisions: CanonicalNameCollision[] = [];
  for (const kind of ["unicode", "case"] as const) {
    const seen = new Map<string, string[]>();
    for (const name of names) {
      const key =
        kind === "unicode"
          ? name.normalize("NFC")
          : name.normalize("NFC").toLowerCase();
      const group = seen.get(key);
      if (group) {
        if (!group.includes(name)) {
          group.push(name);
        }
      } else {
        seen.set(key, [name]);
      }
    }
    for (const group of seen.values()) {
      if (group.length > 1) {
        collisions.push({ kind, directory, names: group });
      }
    }
  }
  return collisions;
}

export class CanonicalPathResolutionError extends EngineError {
  constructor(message: string, context: string) {
    super(message, {
      code: "ZVEC_GREP.ENGINE.PATHS.CANONICAL_RESOLUTION_FAILED",
      context,
    });
  }
}

type DirectoryEntries = Map<string, string[]>;

/**
 * Resolver mapping CRPs to current absolute paths through per-segment
 * actual-name lookup (NFC match). Results are cached per directory for the
 * lifetime of the resolver; create one per operation/session.
 */
export type CanonicalPathResolver = {
  readonly workspaceRoot: string;
  /** Resolve to an absolute path, or null when a segment is missing. */
  resolveSync(canonicalPath: string): string | null;
  resolve(canonicalPath: string): Promise<string | null>;
  /** The CRP of an absolute path inside this workspace, or null outside. */
  toCanonical(absolutePath: string): string | null;
};

export function createCanonicalPathResolver(
  workspaceRoot: string,
): CanonicalPathResolver {
  const root = normalizePath(workspaceRoot);
  const cache = new Map<string, DirectoryEntries>();

  function entriesFor(directory: string): DirectoryEntries {
    const cached = cache.get(directory);
    if (cached) {
      return cached;
    }
    const entries: DirectoryEntries = new Map();
    let names: string[] = [];
    try {
      names = readdirSync(directory);
    } catch {
      // Missing or unreadable directory: every segment misses.
    }
    for (const name of names) {
      const key = name.normalize("NFC");
      const group = entries.get(key);
      if (group) {
        group.push(name);
      } else {
        entries.set(key, [name]);
      }
    }
    cache.set(directory, entries);
    return entries;
  }

  function select(
    directory: string,
    segment: string,
    entries: DirectoryEntries,
  ): string | null {
    const matches = entries.get(segment.normalize("NFC")) ?? [];
    if (matches.length === 0) {
      return null;
    }
    if (matches.length > 1) {
      throw new CanonicalPathResolutionError(
        "Canonical path segment is ambiguous on this filesystem",
        `directory=${directory} segment=${segment} matches=${matches.join(",")}`,
      );
    }
    return join(directory, matches[0]);
  }

  function resolveSync(canonicalPath: string): string | null {
    if (!isCanonicalRelativePath(canonicalPath)) {
      throw new CanonicalPathResolutionError(
        "Stored canonical path is invalid",
        `canonicalPath=${canonicalPath}`,
      );
    }
    if (canonicalPath === ROOT_CRP) {
      return root;
    }
    let current = root;
    for (const segment of canonicalPath.split("/")) {
      const next = select(current, segment, entriesFor(current));
      if (next === null) {
        return null;
      }
      current = next;
    }
    return current;
  }

  async function resolveAsync(canonicalPath: string): Promise<string | null> {
    if (!isCanonicalRelativePath(canonicalPath)) {
      throw new CanonicalPathResolutionError(
        "Stored canonical path is invalid",
        `canonicalPath=${canonicalPath}`,
      );
    }
    if (canonicalPath === ROOT_CRP) {
      return root;
    }
    let current = root;
    for (const segment of canonicalPath.split("/")) {
      const cached = cache.get(current);
      if (cached) {
        const next = select(current, segment, cached);
        if (next === null) {
          return null;
        }
        current = next;
        continue;
      }
      let names: string[] = [];
      try {
        names = await readdir(current);
      } catch {
        // Missing or unreadable directory: every segment misses.
      }
      const entries: DirectoryEntries = new Map();
      for (const name of names) {
        const key = name.normalize("NFC");
        const group = entries.get(key);
        if (group) {
          group.push(name);
        } else {
          entries.set(key, [name]);
        }
      }
      cache.set(current, entries);
      const next = select(current, segment, entries);
      if (next === null) {
        return null;
      }
      current = next;
    }
    return current;
  }

  return {
    workspaceRoot: root,
    resolveSync,
    resolve: resolveAsync,
    toCanonical: (absolutePath) => canonicalRelativePath(root, absolutePath),
  };
}

/** One-way relocation token persisted in the manifest (never a usable path). */
export function workspaceRootFingerprint(workspaceRoot: string): string {
  return sha256Text(resolve(workspaceRoot).normalize("NFC"));
}
