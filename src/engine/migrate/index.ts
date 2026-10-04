import { dirname, isAbsolute, join } from "node:path";
import { WorkspaceBindingStore } from "../bindings.js";
import { EngineError } from "../errors.js";
import {
  appendReservationCleanup,
  reserveDestination,
  type DestinationReservation,
} from "../reservation.js";
import {
  assertHomeNotIncomplete,
  writeWorkspaceManifest,
} from "../manifest.js";
import {
  createFilesSchema,
  createEntitiesSchema,
  parseContent,
  parseMetadata,
  parseRange,
} from "../storage/index.js";
import { resolveWorkspaceIndexStoragePaths } from "../storage/layout.js";
import { CURRENT_INDEX_VERSION } from "../types.js";
import {
  canonicalRelativePath,
  createCanonicalPathResolver,
  isCanonicalRelativePath,
  makeFileId,
  workspaceRootCrp,
} from "../utils/canonical-path.js";
import { sha256Text } from "../utils/hash.js";
import { readJsonFileSync } from "../utils/json.js";
import { acquireReadWriteLock } from "../utils/lock.js";
import {
  ZVecCreateAndOpen,
  ZVecInitialize,
  ZVecLogLevel,
  ZVecOpen,
  type ZVecCollection,
  type ZVecDoc,
  type ZVecStatus,
} from "@zvec/zvec";

/**
 * Migration of a legacy (format version 1, absolute-path) workspace index
 * into the portable format (version 2). The source is never modified; the
 * destination is built in an exclusive staging directory, verified, and only
 * then moved into place. No embedding computation occurs: stored vectors and
 * fragment content are preserved exactly while path-derived identities are
 * remapped. The migrated index carries no verification claim; its first
 * indexing run reconciles content by hash.
 */

export type MigrateWorkspaceIndexOptions = {
  /** Current location of the legacy index home (`<workspace>/.zvec-grep`). */
  sourceHome: string;
  /** Root of the destination workspace receiving the portable index. */
  destinationRoot: string;
  /** Maximum number of entities compared vector-by-vector (0 = all). */
  verifySampleLimit?: number;
  onProgress?: (stage: string, detail: string) => void;
};

export type MigrateWorkspaceIndexResult = {
  destinationHome: string;
  indexId: string;
  filesConverted: number;
  entitiesConverted: number;
  /** Canonical paths whose files are absent at the destination. */
  missingFiles: string[];
  /** True when the legacy manifest carried a credential that was dropped. */
  droppedPersistedCredential: boolean;
  /** True when the legacy manifest carried a device setting that was dropped. */
  droppedPersistedDevice: boolean;
  verification: IndexConversionVerification;
};

export type IndexConversionVerification = {
  countsMatch: boolean;
  identitiesUnique: boolean;
  identitiesDerived: boolean;
  requiredFieldsValid: boolean;
  ownershipValid: boolean;
  inventoriesExact: boolean;
  groupIntegrity: boolean;
  vectorsSampled: boolean;
  vectorsCompared: number;
  vectorsExact: boolean;
};

export type LegacyManifest = {
  manifestVersion: 1;
  id: string;
  name: string;
  path: string;
  rootPaths: {
    absolutePath: string;
    recursive: boolean;
    ignoreFiles?: string[];
    include?: string[];
    exclude?: string[];
    globs?: string[];
    insensitiveGlobs?: string[];
    fileTypes?: string[];
    excludedFileTypes?: string[];
    hidden?: boolean;
    noIgnore?: boolean;
    maxDepth?: number;
    maxFileSizeBytes?: number;
    follow?: boolean;
  }[];
  indexPolicy: "enabled" | "disabled";
  embedding: {
    provider: string;
    model: string;
    dimension: number;
    metric: "cosine" | "dot" | "euclidean";
  } | null;
  indexVersion: number | null;
  createdTime: number;
  updatedTime: number;
  embeddingRuntime: { apiKey?: string; endpoint?: string; device?: string };
};

const ENTITY_VECTOR_FIELD = "embedding";
const DEFAULT_VERIFY_SAMPLE_LIMIT = 256;

export async function migrateWorkspaceIndex(
  options: MigrateWorkspaceIndexOptions,
): Promise<MigrateWorkspaceIndexResult> {
  const report = options.onProgress ?? (() => undefined);
  const sourceHome = options.sourceHome;
  const destinationRoot = options.destinationRoot;
  const manifestPath = join(sourceHome, "manifest.json");

  // Hold a read lock for the whole conversion, acquired before any read so
  // writers are excluded across the manifest and both collections.
  const lock = acquireReadWriteLock(join(sourceHome, "locks", "home"), "read", {
    operation: "index.migrate",
  });

  // Every successfully opened native handle is closed in reverse order in
  // the finalizer, before staging cleanup and lock release.
  const openHandles: ZVecCollection[] = [];
  const closeAll = () => {
    for (const handle of openHandles.splice(0).reverse()) {
      try {
        handle.closeSync();
      } catch {
        // Cleanup is best-effort; the operation already reports its own error.
      }
    }
  };

  let reservation: DestinationReservation | undefined;
  try {
    // The incomplete-home guard runs under the source lock before any
    // metadata read: a crashed reservation blocks migration even after its
    // owner is gone.
    assertHomeNotIncomplete(sourceHome);
    const raw = readJsonFileSync<unknown>(manifestPath, null);
    if (raw === null) {
      throw migrationError("Legacy index manifest not found", manifestPath);
    }
    const manifest = parseLegacyManifest(raw, manifestPath);
    if (!manifest.embedding || manifest.indexVersion === null) {
      throw migrationError(
        "Legacy workspace has no built index to migrate",
        manifestPath,
      );
    }

    // The original host's workspace root: every v1 absolute path is
    // interpreted against it, even when it does not exist on this host.
    const originalRoot = dirname(manifest.path);
    const destinationHome = join(destinationRoot, ".zvec-grep");

    report("read", "Reading legacy index");
    ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
    const sourcePaths = resolveWorkspaceIndexStoragePaths(sourceHome);
    const sourceFiles = track(
      ZVecOpen(sourcePaths.filesPath, { readOnly: true }),
    );
    const sourceEntities = track(
      ZVecOpen(sourcePaths.indexPath, { readOnly: true }),
    );
    const fileDocs = [...sourceFiles.iterDocsSync({ includeVector: false })];
    const entityDocs = [
      ...sourceEntities.iterDocsSync({ includeVector: true }),
    ];
    // Finish source reads before native destination handles are created.
    // Keep the source read lock until publication and cleanup have finished.
    closeTracked(sourceFiles);
    closeTracked(sourceEntities);

    // Remap file identities to canonical workspace-relative paths.
    report("remap", "Remapping file identities");
    const resolver = createCanonicalPathResolver(destinationRoot);
    const { fileIdByOld, canonicalByOldFileId, fragmentIdByOld } =
      computeLegacyIdentityRemaps(
        originalRoot,
        manifest.id,
        fileDocs,
        entityDocs,
      );

    // Reserve the destination exclusively before building anything: the
    // write lock is the reservation, staging lives inside it, and
    // publication commits exactly once when it is released.
    const reserved = reserveDestination({
      destinationHome,
      operation: "index.migrate",
      existingIndexMarkers: ["manifest.json", "files.zvec", "index.zvec"],
    });
    reservation = reserved;
    report("write", "Writing portable destination");
    const stagingPaths = resolveWorkspaceIndexStoragePaths(
      reserved.stagingHome,
    );
    const destFiles = track(
      ZVecCreateAndOpen(stagingPaths.filesPath, createFilesSchema()),
    );
    const destEntities = track(
      ZVecCreateAndOpen(
        stagingPaths.indexPath,
        createEntitiesSchema(manifest.embedding),
      ),
    );

    const missingFiles: string[] = [];
    for (const doc of fileDocs) {
      const canonicalPath = canonicalByOldFileId.get(doc.id)!;
      const newId = fileIdByOld.get(doc.id)!;
      const rootCrp = rootCanonicalFromLegacy(
        String(doc.fields.root_path ?? ""),
        originalRoot,
      );
      const entityIds = JSON.parse(
        String(doc.fields.entity_ids_json ?? "[]"),
      ) as string[];
      const existence = resolver.resolveDetailedSync(canonicalPath);
      if (existence.status === "forbidden") {
        throw migrationError(
          "Destination file escapes the workspace through a symlink",
          `canonicalPath=${canonicalPath} resolved=${existence.path}`,
        );
      }
      if (existence.status === "missing") {
        missingFiles.push(canonicalPath);
      }
      const { absolute_path: _legacyAbsolute, ...portableFields } = doc.fields;
      assertInsertOk(
        destFiles.insertSync({
          id: newId,
          fields: {
            ...portableFields,
            file_id: newId,
            canonical_path: canonicalPath,
            root_path: rootCrp,
            entity_ids_json: JSON.stringify(
              entityIds.map((old) => fragmentIdByOld.get(old) ?? old),
            ),
          },
        }),
        newId,
      );
    }
    for (const doc of entityDocs) {
      const newId = fragmentIdByOld.get(doc.id)!;
      const group = doc.fields.group;
      assertInsertOk(
        destEntities.insertSync({
          id: newId,
          vectors: { [ENTITY_VECTOR_FIELD]: doc.vectors[ENTITY_VECTOR_FIELD] },
          fields: {
            ...doc.fields,
            file_id: fileIdByOld.get(String(doc.fields.file_id ?? ""))!,
            ...(typeof group === "string" && group.length > 0
              ? { group: fragmentIdByOld.get(group) ?? group }
              : {}),
          },
        }),
        newId,
      );
    }
    closeTracked(destFiles);
    closeTracked(destEntities);

    // Verify the staged destination before activation.
    report("verify", "Verifying portable destination");
    const vectorById = new Map(
      entityDocs.map((doc) => [
        fragmentIdByOld.get(doc.id)!,
        doc.vectors[ENTITY_VECTOR_FIELD],
      ]),
    );
    const verification = verifyConvertedIndex(
      stagingPaths,
      { files: fileDocs.length, entities: entityDocs.length },
      vectorById,
      options.verifySampleLimit ?? DEFAULT_VERIFY_SAMPLE_LIMIT,
      manifest.id,
    );
    if (!verificationPassed(verification)) {
      throw migrationError(
        "Migrated destination failed verification",
        JSON.stringify(verification),
      );
    }

    const droppedPersistedCredential =
      typeof manifest.embeddingRuntime?.apiKey === "string";
    const droppedPersistedDevice =
      typeof manifest.embeddingRuntime?.device === "string";

    // Supported replacement workflow: verification is invalidated before
    // publication releases its reservation, never after the commit window.
    new WorkspaceBindingStore().invalidate(manifest.id, destinationRoot);
    // Publication: finalize the manifest into staging, move children with
    // the manifest last, and commit once at reservation release.
    reserved.publish(() =>
      writeWorkspaceManifest(reserved.stagingHome, {
        manifestVersion: 2,
        id: manifest.id,
        name: manifest.name,
        rootPaths: convertLegacyRootPaths(manifest.rootPaths, originalRoot),
        indexPolicy: manifest.indexPolicy,
        embedding: manifest.embedding,
        indexVersion: CURRENT_INDEX_VERSION,
        createdTime: manifest.createdTime,
        updatedTime: Date.now(),
        embeddingRuntime: {
          ...(typeof manifest.embeddingRuntime?.endpoint === "string"
            ? { endpoint: manifest.embeddingRuntime.endpoint }
            : {}),
        },
      }),
    );
    report("done", "Migration complete");

    return {
      destinationHome,
      indexId: manifest.id,
      filesConverted: fileDocs.length,
      entitiesConverted: entityDocs.length,
      missingFiles,
      droppedPersistedCredential,
      droppedPersistedDevice,
      verification,
    };
  } catch (error) {
    // Native handles close before any filesystem cleanup.
    closeAll();
    const cleanup = reservation?.abort();
    if (cleanup) {
      throw appendReservationCleanup(error, cleanup);
    }
    throw error;
  } finally {
    lock.release();
  }

  function track(collection: ZVecCollection): ZVecCollection {
    openHandles.push(collection);
    return collection;
  }

  function closeTracked(collection: ZVecCollection): void {
    const index = openHandles.indexOf(collection);
    if (index >= 0) {
      openHandles.splice(index, 1);
    }
    collection.closeSync();
  }
}

/**
 * Compute portable identities for a legacy (v1) index: canonical paths and
 * remapped file/fragment IDs, with duplicate and orphan detection.
 */
export function computeLegacyIdentityRemaps(
  originalRoot: string,
  indexId: string,
  fileDocs: readonly ZVecDoc[],
  entityDocs: readonly ZVecDoc[],
): {
  fileIdByOld: Map<string, string>;
  canonicalByOldFileId: Map<string, string>;
  fragmentIdByOld: Map<string, string>;
} {
  const fileIdByOld = new Map<string, string>();
  const canonicalByOldFileId = new Map<string, string>();
  for (const doc of fileDocs) {
    const absolutePath = String(doc.fields.absolute_path ?? "");
    const canonicalPath = canonicalRelativePath(originalRoot, absolutePath);
    if (canonicalPath === null || !isCanonicalRelativePath(canonicalPath)) {
      throw migrationError(
        "Legacy index contains files outside the original workspace root; external roots need an explicit mapping",
        `file=${absolutePath} originalRoot=${originalRoot}`,
      );
    }
    fileIdByOld.set(doc.id, makeFileId(indexId, canonicalPath));
    canonicalByOldFileId.set(doc.id, canonicalPath);
  }
  if (new Set(fileIdByOld.values()).size !== fileIdByOld.size) {
    throw migrationError(
      "Legacy index maps multiple records to the same canonical identity",
      originalRoot,
    );
  }

  const fragmentIdByOld = new Map<string, string>();
  for (const doc of entityDocs) {
    const newFileId = fileIdByOld.get(String(doc.fields.file_id ?? ""));
    if (!newFileId) {
      throw migrationError(
        "Legacy entity references an unknown file record",
        `entity=${doc.id} fileId=${String(doc.fields.file_id)}`,
      );
    }
    const fragmentIndex = Number(doc.fields.fragment_index ?? 0);
    fragmentIdByOld.set(doc.id, sha256Text(`${newFileId}\0${fragmentIndex}`));
  }
  if (new Set(fragmentIdByOld.values()).size !== fragmentIdByOld.size) {
    throw migrationError(
      "Legacy index maps multiple fragments to the same identity",
      originalRoot,
    );
  }

  return { fileIdByOld, canonicalByOldFileId, fragmentIdByOld };
}

function verificationPassed(
  verification: IndexConversionVerification,
): boolean {
  return (
    verification.countsMatch &&
    verification.identitiesUnique &&
    verification.identitiesDerived &&
    verification.requiredFieldsValid &&
    verification.ownershipValid &&
    verification.inventoriesExact &&
    verification.groupIntegrity &&
    verification.vectorsExact
  );
}

export function verifyConvertedIndex(
  stagingPaths: { filesPath: string; indexPath: string },
  expectedCounts: { files: number; entities: number },
  vectorById: ReadonlyMap<string, unknown>,
  sampleLimit: number,
  indexId: string,
): IndexConversionVerification {
  const destFiles = ZVecOpen(stagingPaths.filesPath, { readOnly: true });
  const destEntities = ZVecOpen(stagingPaths.indexPath, { readOnly: true });
  try {
    const destFileDocs = [...destFiles.iterDocsSync({ includeVector: false })];
    const destEntityDocs = [
      ...destEntities.iterDocsSync({ includeVector: true }),
    ];

    const countsMatch =
      destFileDocs.length === expectedCounts.files &&
      destEntityDocs.length === expectedCounts.entities;

    const fileIds = new Set(destFileDocs.map((doc) => doc.id));
    const entityIds = new Set(destEntityDocs.map((doc) => doc.id));
    const identitiesUnique =
      fileIds.size === destFileDocs.length &&
      entityIds.size === destEntityDocs.length;

    // Application-level identity: native IDs, stored identity fields, and
    // the portable derivation (index UUID + canonical path) must all agree,
    // and required fields must be present and typed.
    const canonicalPaths = new Set<string>();
    const derivedFileIds = new Set<string>();
    let identitiesDerived = true;
    let requiredFieldsValid = true;
    for (const doc of destFileDocs) {
      const canonicalPath = String(doc.fields.canonical_path ?? "");
      const validPath =
        isCanonicalRelativePath(canonicalPath) && canonicalPath !== ".";
      if (!validPath || canonicalPaths.has(canonicalPath)) {
        identitiesDerived = false;
      }
      canonicalPaths.add(canonicalPath);
      const derived = validPath ? makeFileId(indexId, canonicalPath) : null;
      if (
        derived === null ||
        doc.id !== derived ||
        String(doc.fields.file_id ?? "") !== derived
      ) {
        identitiesDerived = false;
      } else {
        derivedFileIds.add(derived);
      }
      if (
        typeof doc.fields.relative_path !== "string" ||
        doc.fields.relative_path.length === 0 ||
        typeof doc.fields.root_path !== "string" ||
        !isCanonicalRelativePath(String(doc.fields.root_path)) ||
        !Number.isInteger(doc.fields.size_bytes) ||
        !Number.isInteger(doc.fields.last_modified_time) ||
        typeof doc.fields.kind !== "string" ||
        typeof doc.fields.format !== "string"
      ) {
        requiredFieldsValid = false;
      }
    }
    for (const doc of destEntityDocs) {
      const fileId = String(doc.fields.file_id ?? "");
      const fragmentIndex = Number(doc.fields.fragment_index);
      if (
        derivedFileIds.has(fileId) &&
        (!Number.isInteger(fragmentIndex) ||
          fragmentIndex < 0 ||
          doc.id !== sha256Text(`${fileId}\0${fragmentIndex}`))
      ) {
        identitiesDerived = false;
      }
      // Serialized fields must parse through the application's reader
      // schemas; nonempty text alone does not make the record usable.
      if (
        typeof doc.fields.range_json !== "string" ||
        doc.fields.range_json.length === 0
      ) {
        requiredFieldsValid = false;
      } else {
        try {
          parseRange(doc.fields.range_json);
          parseContent(doc.fields);
          parseMetadata(doc.fields);
        } catch {
          requiredFieldsValid = false;
        }
      }
    }

    // Ownership: every entity belongs to a converted file, and every group
    // stays within one file with exactly one major fragment owned by it.
    const ownershipValid = destEntityDocs.every((doc) =>
      fileIds.has(String(doc.fields.file_id ?? "")),
    );
    const groups = new Map<string, { fileId: string; majors: number }>();
    let groupIntegrity = true;
    for (const doc of destEntityDocs) {
      const group =
        typeof doc.fields.group === "string" && doc.fields.group.length > 0
          ? doc.fields.group
          : doc.id;
      const fileId = String(doc.fields.file_id ?? "");
      const current = groups.get(group);
      if (!current) {
        groups.set(group, { fileId, majors: doc.id === group ? 1 : 0 });
      } else if (current.fileId !== fileId) {
        groupIntegrity = false;
        break;
      } else if (doc.id === group) {
        current.majors += 1;
      }
    }
    if (groupIntegrity) {
      groupIntegrity = [...groups.values()].every(
        (group) => group.majors === 1,
      );
    }

    // Inventories: the stored public ID set of each file is exactly the
    // computed public entity set of that file (major or ungrouped fragments).
    const publicIdsByFile = new Map<string, Set<string>>();
    for (const doc of destEntityDocs) {
      const group = doc.fields.group;
      const isPublic =
        typeof group !== "string" || group.length === 0 || group === doc.id;
      if (!isPublic) {
        continue;
      }
      const fileId = String(doc.fields.file_id ?? "");
      const set = publicIdsByFile.get(fileId) ?? new Set<string>();
      set.add(typeof group === "string" && group.length > 0 ? group : doc.id);
      publicIdsByFile.set(fileId, set);
    }
    const inventoriesExact = destFileDocs.every((doc) => {
      const stored = new Set(
        JSON.parse(String(doc.fields.entity_ids_json ?? "[]")) as string[],
      );
      const computed = publicIdsByFile.get(doc.id) ?? new Set<string>();
      return (
        stored.size === computed.size &&
        [...stored].every((id) => computed.has(id))
      );
    });

    const sampled = sampleLimit > 0 && destEntityDocs.length > sampleLimit;
    const sample = sampled
      ? destEntityDocs.filter(
          (_, index) =>
            index % Math.floor(destEntityDocs.length / sampleLimit) === 0,
        )
      : destEntityDocs;
    let vectorsCompared = 0;
    let vectorsExact = true;
    for (const doc of sample) {
      const sourceVector = vectorToArray(vectorById.get(doc.id));
      const destVector = vectorToArray(doc.vectors[ENTITY_VECTOR_FIELD]);
      vectorsCompared++;
      if (
        !sourceVector ||
        !destVector ||
        sourceVector.length !== destVector.length ||
        !sourceVector.every((value, index) => value === destVector[index])
      ) {
        vectorsExact = false;
        break;
      }
    }

    return {
      countsMatch,
      identitiesUnique,
      identitiesDerived,
      requiredFieldsValid,
      ownershipValid,
      inventoriesExact,
      groupIntegrity,
      vectorsSampled: sampled,
      vectorsCompared,
      vectorsExact,
    };
  } finally {
    destFiles.closeSync();
    destEntities.closeSync();
  }
}

function assertInsertOk(status: ZVecStatus, id: string): void {
  if (!status.ok) {
    throw migrationError(
      "Native write failed during destination build",
      `id=${id} code=${status.code} message=${status.message}`,
    );
  }
}

export function convertLegacyRootPaths(
  rootPaths: LegacyManifest["rootPaths"],
  originalRoot: string,
): {
  path: string;
  recursive: boolean;
  ignoreFiles?: string[];
  include?: string[];
  exclude?: string[];
  globs?: string[];
  insensitiveGlobs?: string[];
  fileTypes?: string[];
  excludedFileTypes?: string[];
  hidden?: boolean;
  noIgnore?: boolean;
  maxDepth?: number;
  maxFileSizeBytes?: number;
  follow?: boolean;
}[] {
  return rootPaths.map((root) => {
    const { absolutePath, ...options } = root;
    const path = rootCanonicalFromLegacy(absolutePath, originalRoot);
    const ignoreFiles = root.ignoreFiles?.map((entry) =>
      legacyIgnoreFileToCanonical(entry, absolutePath, originalRoot),
    );
    return {
      ...options,
      path,
      ...(ignoreFiles !== undefined ? { ignoreFiles } : {}),
    };
  });
}

export function rootCanonicalFromLegacy(
  rootAbsolutePath: string,
  originalRoot: string,
): string {
  const canonicalPath =
    rootAbsolutePath === originalRoot
      ? workspaceRootCrp()
      : canonicalRelativePath(originalRoot, rootAbsolutePath);
  if (canonicalPath === null) {
    throw migrationError(
      "Legacy scan root is outside the original workspace root",
      `root=${rootAbsolutePath} originalRoot=${originalRoot}`,
    );
  }
  return canonicalPath;
}

export function legacyIgnoreFileToCanonical(
  entry: string,
  rootAbsolutePath: string,
  originalRoot: string,
): string {
  const absolutePath = isAbsolute(entry)
    ? entry
    : join(rootAbsolutePath, entry);
  const canonicalPath = canonicalRelativePath(originalRoot, absolutePath);
  if (canonicalPath === null) {
    throw migrationError(
      "Legacy ignore file is outside the original workspace root; external ignore files need an explicit mapping",
      `ignoreFile=${entry} root=${rootAbsolutePath} originalRoot=${originalRoot}`,
    );
  }
  return canonicalPath;
}

function vectorToArray(vector: unknown): number[] | null {
  if (vector === undefined || vector === null) {
    return null;
  }
  if (Array.isArray(vector)) {
    return vector.map((value) => Number(value));
  }
  if (ArrayBuffer.isView(vector)) {
    return Array.from(vector as Float32Array);
  }
  if (isRecord(vector)) {
    const result: number[] = [];
    for (const key of Object.keys(vector)) {
      result[Number(key)] = Number(vector[key]);
    }
    return result;
  }
  return null;
}

function parseLegacyManifest(value: unknown, context: string): LegacyManifest {
  const record = isRecord(value) ? value : null;
  if (record?.manifestVersion === 2) {
    throw migrationError(
      "Workspace index already uses the portable format",
      context,
    );
  }
  if (
    !record ||
    record.manifestVersion !== 1 ||
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.path !== "string" ||
    !Array.isArray(record.rootPaths) ||
    record.rootPaths.length === 0 ||
    !record.rootPaths.every(
      (root) => isRecord(root) && typeof root.absolutePath === "string",
    ) ||
    (record.indexPolicy !== "enabled" && record.indexPolicy !== "disabled") ||
    typeof record.createdTime !== "number" ||
    typeof record.updatedTime !== "number" ||
    !isRecord(record.embeddingRuntime)
  ) {
    throw migrationError("Legacy index manifest is invalid", context);
  }
  return record as unknown as LegacyManifest;
}

function migrationError(message: string, context: string): EngineError {
  return new EngineError(`Workspace index migration failed: ${message}`, {
    code: "ZVEC_GREP.ENGINE.MIGRATION.FAILED",
    context,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
