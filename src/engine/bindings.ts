import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readJsonFileSync, writeJsonFileSync } from "./utils/json.js";
import { defaultHome, normalizePath } from "./utils/path.js";

/**
 * Host-local workspace binding records: which physical workspace locations
 * have been content-verified for a given portable index. This store lives in
 * the global home, never inside the workspace, so transferred indexes carry
 * no verification claim. Whenever the current binding cannot be established
 * against the record, the index is treated as unverified and its next
 * indexing run reconciles by content hash.
 */

export type WorkspaceBinding = {
  /** NFC realpath of the verified workspace root. */
  rootPath: string;
  device: number;
  inode: number;
  verifiedTime: number;
};

type BindingRecord = {
  version: 1;
  bindings: WorkspaceBinding[];
};

const BINDINGS_DIRECTORY = "bindings";
const MAX_BINDINGS_PER_INDEX = 8;
const MAX_INDEX_ENTRIES = 1024;

export function currentWorkspaceBinding(
  workspaceRoot: string,
): Omit<WorkspaceBinding, "verifiedTime"> | null {
  try {
    const realRoot = normalizePath(workspaceRoot).normalize("NFC");
    const info = statSync(realRoot);
    return { rootPath: realRoot, device: info.dev, inode: info.ino };
  } catch {
    return null;
  }
}

export class WorkspaceBindingStore {
  constructor(private readonly home: string = defaultHome()) {}

  /**
   * True when a record proves this index was content-verified at the current
   * binding. Any doubt — missing store, missing entry, changed path or
   * changed filesystem identity — means unverified.
   */
  matches(indexId: string, workspaceRoot: string): boolean {
    const current = currentWorkspaceBinding(workspaceRoot);
    if (!current) {
      return false;
    }
    return this.readBindings(indexId).some(
      (binding) =>
        binding.rootPath === current.rootPath &&
        binding.device === current.device &&
        binding.inode === current.inode,
    );
  }

  /** Record a successful content verification at the current binding. */
  record(indexId: string, workspaceRoot: string): void {
    const current = currentWorkspaceBinding(workspaceRoot);
    if (!current) {
      return;
    }
    const bindings = this.readBindings(indexId).filter(
      (binding) =>
        !(
          binding.rootPath === current.rootPath &&
          binding.device === current.device &&
          binding.inode === current.inode
        ),
    );
    bindings.push({ ...current, verifiedTime: Date.now() });
    const trimmed = bindings.slice(-MAX_BINDINGS_PER_INDEX);
    writeJsonFileSync(
      this.recordPath(indexId),
      { version: 1, bindings: trimmed } satisfies BindingRecord,
      { directoryMode: 0o700, fileMode: 0o600 },
    );
    this.evictOldIndexes();
  }

  private recordPath(indexId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(indexId)) {
      throw new Error(`Invalid index id for binding record: ${indexId}`);
    }
    return join(this.home, BINDINGS_DIRECTORY, `${indexId}.json`);
  }

  private readBindings(indexId: string): WorkspaceBinding[] {
    let value: BindingRecord | null = null;
    try {
      value = readJsonFileSync<BindingRecord | null>(
        this.recordPath(indexId),
        null,
      );
    } catch {
      return [];
    }
    if (!value || value.version !== 1 || !Array.isArray(value.bindings)) {
      return [];
    }
    return value.bindings.filter(
      (binding) =>
        typeof binding?.rootPath === "string" &&
        typeof binding.device === "number" &&
        typeof binding.inode === "number" &&
        typeof binding.verifiedTime === "number",
    );
  }

  private evictOldIndexes(): void {
    // Bounded by index count: removing the oldest record only forces a safe
    // re-verification of that index at its next open.
    try {
      const directory = join(this.home, BINDINGS_DIRECTORY);
      const entries = readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          const path = join(directory, name);
          return { path, mtimeMs: statSync(path).mtimeMs };
        })
        .sort((left, right) => left.mtimeMs - right.mtimeMs);
      for (const entry of entries.slice(
        0,
        Math.max(0, entries.length - MAX_INDEX_ENTRIES),
      )) {
        unlinkSync(entry.path);
      }
    } catch {
      // Eviction is best-effort; a full store only costs re-verification.
    }
  }
}
