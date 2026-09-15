# Portable workspace index — identity and path contract

Design status: **fork specification baseline, accepted 2026-09-15; behavior not
yet demonstrated**. This document is the contract the implementation and its
validation must satisfy. User-facing documentation is updated only after the
behavior is demonstrated.

Objective: an index built in one location (for example macOS with Metal) can be
transferred with its workspace to another location or host (for example Linux
with CPU) and then searched and incrementally updated **without re-embedding
unchanged documents**. Query embedding remains a normal per-search operation.

## 1. Scope and definitions

- **Workspace**: the directory that contains `.zvec-grep/`. Index discovery is
  the existing upward walk; the physical layout does not change.
- **Self-contained workspace**: every configured scan root resolves inside the
  workspace root after symlink resolution. Version 1 supports only
  self-contained workspaces; a scan root outside the workspace is an explicit
  error in portable mode. External roots need a later mapping design.
- **CRP (canonical workspace-relative path)**: a file's location inside the
  workspace, defined in §2.

## 2. Canonical workspace-relative path

1. The CRP is the file's path relative to the workspace root: segments joined
   with `/`, no leading or trailing slash, no `.` or `..` segments, Unicode
   NFC-normalized, letter case preserved from the actual directory entry.
2. A CRP is derived from actual directory entries (`readdir` results), never
   from user-supplied strings alone.
3. **Resolution** (CRP → current absolute path): per-segment lookup against the
   current filesystem. For each segment, read the containing directory and
   select the entry whose NFC form equals the segment. Zero matches means the
   file is missing; more than one is a collision error. This handles
   filesystems that store a different Unicode form than the canonical one.
4. **Collision rejection**: during scanning, two entries in one directory whose
   NFC forms are equal, or whose case-folded NFC forms are equal, are an
   explicit scan error naming both. This protects case-insensitive and
   normalizing destination filesystems.
5. **Containment**: a stored CRP that would resolve outside the workspace root
   (through `..` or a symlink) is rejected. A scanned entry whose symlink
   target escapes the workspace root is excluded with an explicit diagnostic.
6. `/` is the stored separator on every platform, including Windows.

## 3. Persistent identities

1. The workspace index UUID (`manifest.id`) is unchanged and is preserved by
   copying and by conversion.
2. `fileId = sha256hex(workspaceIndexId + "\0" + CRP)`. The separator
   convention matches the current scheme; the location input replaces the
   absolute path.
3. `fragmentId = sha256hex(fileId + "\0" + index)` — unchanged derivation;
   fragment IDs stay stable because file IDs stay stable.
4. Group references keep their current semantics (a group's value is its major
   fragment's ID) and are stable for the same reason.
5. **Renames**: version 1 treats a rename as delete + add under the existing
   diff semantics. That is correct (no stale or orphaned records) but not
   optimized: renamed files are re-embedded. Vector transfer or ID-preserving
   rename maps are a separate, later decision.

## 4. Persistent data vs host bindings

The manifest (format version 2) stores only portable data:

- `id`, `name`, `manifestVersion: 2`
- `rootPaths`: scan roots as CRPs with their existing selection options
- `indexPolicy`, `embedding` (provider, model, dimension, metric — the
  endpoint stays part of the embedding identity per current rebuild rules),
  `indexVersion`, `createdTime`, `updatedTime`
- `rootFingerprint`: `sha256hex(NFC canonical absolute workspace root)` — a
  one-way relocation token, not a usable path (§5)

The manifest does **not** store: its own absolute location, absolute root
paths, `device`, or `apiKey`.

- **Storage location**: always the discovered `<workspace>/.zvec-grep`. A
  persisted location is unnecessary and is removed; the stale-binding failure
  mode disappears structurally.
- **Device**: runtime-only, resolved per host with the existing `auto`
  default. Never persisted, never inherited across hosts.
- **Credentials**: `apiKey` is never persisted in the manifest. Remote
  providers resolve credentials per session from explicit options, environment,
  or global configuration, as they already can.
- **Locks and runtime caches**: remain keyed by the canonical physical root
  (existing daemon behavior). Two copies of one index on a single host are two
  distinct physical roots and never share a writer or storage handle.

## 5. Rebind reconciliation

1. On open, all persisted paths are interpreted relative to the current
   workspace root. The current `rootFingerprint` is recomputed; a mismatch
   with the stored fingerprint marks the index **unverified**.
2. The next indexing run on an unverified index performs a **reconciliation
   pass**: every scanned file that matches a stored record by file ID is
   content-hashed regardless of size/mtime agreement.
   - Identical content: the record and its vectors are reused. Stored size and
     mtime metadata are refreshed. No embedding calls occur.
   - Changed content: normal incremental handling.
   - Missing files: normal deletion handling.
3. When reconciliation completes, the new fingerprint is stored.
4. Acceptance: unchanged relocated content causes **zero** document-embedding
   calls. Query embedding is separate and expected.

## 6. Version gates and migration

1. `manifestVersion: 2`: version-1 executables reject it through the existing
   manifest validation with a clear error. A version-2 executable reading a
   version-1 manifest reports that the index needs migration; it does not
   silently reinterpret version-1 absolute-path records.
2. `indexVersion` is bumped for the new files-collection schema (CRP identity,
  no persisted absolute path). Old executables reject the new storage through
   the existing version check.
3. **Converter**: an explicit operation that reads a **closed** version-1
   index, validates the original source-root mapping, computes CRPs, and
   writes a separate version-2 destination:
   - full ID remapping (file IDs, fragment IDs, group references,
     `entity_ids_json` inventories) with the index UUID preserved — the
     accepted decision; no permanent lookup table;
   - stored vectors and fragment content preserved byte-exactly;
   - verification of the destination (file and entity counts, group integrity,
     sample vector equality, sample searches) before activation;
   - the source is never modified; an interrupted or rejected conversion
     leaves it usable.

## 7. Export and import (logical portability)

Logical export/import is the required fallback if native database files do not
survive cross-platform transfer, and it is the converter's substrate.

1. **Consistency**: the source is closed, or writers are excluded across both
   collections and the manifest for the whole export. Per-collection snapshots
   under live writes do not establish whole-index consistency.
2. **Completeness**: the entities collection is iterated directly (not through
   the public per-file inventory), so secondary fragments and their vectors are
   included.
3. **Artifact**: format version, embedding schema, all scalar fields, fragment
   content, and vectors. No credential material: the manifest is exported in
   version-2 form (no absolute location, no device, no API key).
4. **Import**: recreate collections with identical schema, metric, and
   dimension; batch-insert preserving or remapping IDs; finalize; verify
   counts, spot vector equality, and sample queries. Import pays structure
   rebuild, never inference.

## 8. Test obligations

- Relocate A→B with A unavailable: search resolves every destination under B;
  refresh produces zero document embeddings and a stable inventory.
- A and B coexist with different contents: operations on B never read or
  modify A.
- Timestamp-only changes: existing vectors reused.
- Changed content with unchanged size/timestamp: detected by the
  reconciliation pass.
- Edit, add, delete, rename: correct incremental behavior without stale or
  orphaned records.
- Multilingual filenames, NFD/NFC forms, case collisions: correct resolution
  or explicit rejection.
- Symlink escaping the workspace: exclusion with diagnostic.
- Two live copies sharing an index UUID: concurrent use without shared locks
  or handles.
- Old executable vs new format and new executable vs old format: clear
  rejection/migration guidance.
- Conversion: vectors and content preserved, relationships intact, source
  untouched after interruption or invalid input.
- Transfer artifacts contain no credential material.
- Optional: native macOS→Linux open probe. Not required if the logical route
  passes.

## 9. Non-goals for version 1

Scan roots outside the workspace; rename optimization; Windows-specific
validation (the contract is Windows-compatible by construction); upstream
acceptance.
