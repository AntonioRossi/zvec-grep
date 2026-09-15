import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { EngineError } from "../errors.js";
import { writeWorkspaceManifest } from "../manifest.js";
import { createFilesSchema, createEntitiesSchema } from "../storage/index.js";
import { resolveWorkspaceIndexStoragePaths } from "../storage/layout.js";
import { CURRENT_INDEX_VERSION } from "../types.js";
import {
  canonicalRelativePath,
  createCanonicalPathResolver,
  isCanonicalRelativePath,
  makeFileId,
  workspaceRootCrp,
  workspaceRootFingerprint,
} from "../utils/canonical-path.js";
import { sha256Text } from "../utils/hash.js";
import { readJsonFileSync } from "../utils/json.js";
import { acquireReadWriteLock } from "../utils/lock.js";
import {
  ZVecCreateAndOpen,
  ZVecInitialize,
  ZVecLogLevel,
  ZVecOpen,
  type ZVecDoc,
} from "@zvec/zvec";

/**
 * Migration of a legacy (format version 1, absolute-path) workspace index
 * into the portable format (version 2). The source is never modified; the
 * destination is built in a staging directory, verified, and only then moved
 * into place. No embedding computation occurs: stored vectors and fragment
 * content are preserved exactly while path-derived identities are remapped.
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
  verification: {
    countsMatch: boolean;
    groupIntegrity: boolean;
    inventoriesResolve: boolean;
    vectorsCompared: number;
    vectorsExact: boolean;
  };
};

type LegacyManifest = {
  manifestVersion: 1;
  id: string;
  name: string;
  path: string;
  rootPaths: { absolutePath: string; recursive: boolean }[];
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

  // The original host's workspace root: every v1 absolute path is interpreted
  // against it, even when it does not exist on this host.
  const originalRoot = dirname(manifest.path);
  const destinationHome = join(destinationRoot, ".zvec-grep");
  if (existsSync(destinationHome)) {
    throw migrationError(
      "Destination already contains a workspace index",
      destinationHome,
    );
  }

  // Hold a read lock for the whole conversion so writers are excluded across
  // both collections and the manifest; per-collection snapshots under live
  // writes do not establish whole-index consistency.
  const lock = acquireReadWriteLock(join(sourceHome, "locks", "home"), "read", {
    operation: "index.migrate",
  });

  const stagingHome = join(
    destinationRoot,
    `.zvec-grep.migrating-${process.pid}-${Date.now()}`,
  );
  try {
    report("read", "Reading legacy index");
    ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
    const sourcePaths = resolveWorkspaceIndexStoragePaths(sourceHome);
    const sourceFiles = ZVecOpen(sourcePaths.filesPath, { readOnly: true });
    const sourceEntities = ZVecOpen(sourcePaths.indexPath, { readOnly: true });

    const fileDocs = [...sourceFiles.iterDocsSync({ includeVector: false })];
    const entityDocs = [
      ...sourceEntities.iterDocsSync({ includeVector: true }),
    ];

    // Remap file identities to canonical workspace-relative paths.
    report("remap", "Remapping file identities");
    const resolver = createCanonicalPathResolver(destinationRoot);
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
      fileIdByOld.set(doc.id, makeFileId(manifest.id, canonicalPath));
      canonicalByOldFileId.set(doc.id, canonicalPath);
    }

    // Per-file fragment ID remaps, keyed by fragment_index.
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

    // Stage the destination.
    report("write", "Writing portable destination");
    mkdirSync(stagingHome, { recursive: true });
    const stagingPaths = resolveWorkspaceIndexStoragePaths(stagingHome);
    const destFiles = ZVecCreateAndOpen(
      stagingPaths.filesPath,
      createFilesSchema(),
    );
    const destEntities = ZVecCreateAndOpen(
      stagingPaths.indexPath,
      createEntitiesSchema(manifest.embedding),
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
      if (resolver.resolveSync(canonicalPath) === null) {
        missingFiles.push(canonicalPath);
      }
      const { absolute_path: _legacyAbsolute, ...portableFields } = doc.fields;
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
      });
    }
    for (const doc of entityDocs) {
      const newId = fragmentIdByOld.get(doc.id)!;
      const group = doc.fields.group;
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
      });
    }
    destFiles.closeSync();
    destEntities.closeSync();

    // Verify the staged destination before activation.
    report("verify", "Verifying portable destination");
    const verification = verifyDestination(
      stagingPaths,
      fileDocs,
      entityDocs,
      fileIdByOld,
      fragmentIdByOld,
      options.verifySampleLimit ?? DEFAULT_VERIFY_SAMPLE_LIMIT,
    );
    if (
      !verification.countsMatch ||
      !verification.groupIntegrity ||
      !verification.inventoriesResolve ||
      !verification.vectorsExact
    ) {
      throw migrationError(
        "Migrated destination failed verification",
        JSON.stringify(verification),
      );
    }

    const droppedPersistedCredential =
      typeof manifest.embeddingRuntime?.apiKey === "string";
    const droppedPersistedDevice =
      typeof manifest.embeddingRuntime?.device === "string";
    writeWorkspaceManifest(stagingHome, {
      manifestVersion: 2,
      id: manifest.id,
      name: manifest.name,
      rootPaths: manifest.rootPaths.map((root) => {
        const { absolutePath, ...options } = root;
        const path = rootCanonicalFromLegacy(absolutePath, originalRoot);
        return { ...options, path };
      }),
      indexPolicy: manifest.indexPolicy,
      embedding: manifest.embedding,
      indexVersion: CURRENT_INDEX_VERSION,
      createdTime: manifest.createdTime,
      updatedTime: Date.now(),
      rootFingerprint: workspaceRootFingerprint(destinationRoot),
      embeddingRuntime: {
        ...(typeof manifest.embeddingRuntime?.endpoint === "string"
          ? { endpoint: manifest.embeddingRuntime.endpoint }
          : {}),
      },
    });

    sourceFiles.closeSync();
    sourceEntities.closeSync();

    renameSync(stagingHome, destinationHome);
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
    rmSync(stagingHome, { recursive: true, force: true });
    throw error;
  } finally {
    lock.release();
  }
}

function rootCanonicalFromLegacy(
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

function verifyDestination(
  stagingPaths: { filesPath: string; indexPath: string },
  sourceFileDocs: readonly ZVecDoc[],
  sourceEntityDocs: readonly ZVecDoc[],
  fileIdByOld: ReadonlyMap<string, string>,
  fragmentIdByOld: ReadonlyMap<string, string>,
  sampleLimit: number,
): MigrateWorkspaceIndexResult["verification"] {
  const destFiles = ZVecOpen(stagingPaths.filesPath, { readOnly: true });
  const destEntities = ZVecOpen(stagingPaths.indexPath, { readOnly: true });
  try {
    const countsMatch =
      destFiles.stats.docCount === sourceFileDocs.length &&
      destEntities.stats.docCount === sourceEntityDocs.length;

    const destEntityDocs = [
      ...destEntities.iterDocsSync({ includeVector: true }),
    ];
    const groups = new Map<string, number>();
    for (const doc of destEntityDocs) {
      const group = typeof doc.fields.group === "string" ? doc.fields.group : doc.id;
      if (doc.id === group) {
        groups.set(group, (groups.get(group) ?? 0) + 1);
      } else if (!groups.has(group)) {
        groups.set(group, groups.get(group) ?? 0);
      }
    }
    const groupIntegrity = [...groups.values()].every((count) => count === 1);

    const destEntityIds = new Set(destEntityDocs.map((doc) => doc.id));
    const inventoriesResolve = [
      ...destFiles.iterDocsSync({ includeVector: false }),
    ].every((doc) =>
      (JSON.parse(String(doc.fields.entity_ids_json ?? "[]")) as string[])
        .every((id) => destEntityIds.has(id)),
    );

    const vectorByNewId = new Map(
      sourceEntityDocs.map((doc) => [
        fragmentIdByOld.get(doc.id)!,
        doc.vectors[ENTITY_VECTOR_FIELD],
      ]),
    );
    const sample =
      sampleLimit > 0 && destEntityDocs.length > sampleLimit
        ? destEntityDocs.filter(
            (_, index) =>
              index % Math.floor(destEntityDocs.length / sampleLimit) === 0,
          )
        : destEntityDocs;
    let vectorsCompared = 0;
    let vectorsExact = true;
    for (const doc of sample) {
      const sourceVector = vectorToArray(vectorByNewId.get(doc.id));
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
      groupIntegrity,
      inventoriesResolve,
      vectorsCompared,
      vectorsExact,
    };
  } finally {
    destFiles.closeSync();
    destEntities.closeSync();
  }
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

function vectorToArray(vector: unknown): number[] | null {
  if (vector === undefined || vector === null) {
    return null;
  }
  if (Array.isArray(vector)) {
    return vector;
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

function migrationError(message: string, context: string): EngineError {
  return new EngineError(`Workspace index migration failed: ${message}`, {
    code: "ZVEC_GREP.ENGINE.MIGRATION.FAILED",
    context,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
