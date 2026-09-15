import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  ZVecCollectionSchema,
  ZVecCreateAndOpen,
  ZVecDataType,
  ZVecIndexType,
  ZVecInitialize,
  ZVecLogLevel,
  ZVecOpen,
} from "@zvec/zvec";
import { readWorkspaceManifest } from "../../dist/engine/manifest.js";
import { migrateWorkspaceIndex } from "../../dist/engine/migrate/index.js";
import { createEntitiesSchema } from "../../dist/engine/storage/index.js";
import { resolveWorkspaceIndexStoragePaths } from "../../dist/engine/storage/layout.js";
import { createZvecGrep } from "../../dist/index.js";
import { createTemporaryDirectory } from "../helpers/fixtures.mjs";
import { FakeEmbeddingModel } from "../helpers/fake-embedding.mjs";

const EMBEDDING = {
  provider: "test",
  model: "deterministic",
  dimension: 16,
  metric: "cosine",
};

const FIXTURES = {
  "docs/guide.md": [
    "# Getting started",
    "",
    "Install the tool and run the indexer on the workspace.",
    "",
    "## Configuration",
    "",
    "Set the model and the device in the configuration file.",
    "",
  ].join("\n"),
  "src/util.ts": [
    "export function normalizeEndpoint(value: string): string {",
    "  return value.trim().toLowerCase();",
    "}",
    "",
  ].join("\n"),
};

function oldFileId(indexId, absolutePath) {
  return createHash("sha256")
    .update(`${indexId}\0${resolve(absolutePath)}`)
    .digest("hex");
}

function oldFragmentId(oldId, fragmentIndex) {
  return createHash("sha256").update(`${oldId}\0${fragmentIndex}`).digest("hex");
}

function indexedString(name, nullable = false) {
  return {
    name,
    dataType: ZVecDataType.STRING,
    nullable,
    indexParams: { indexType: ZVecIndexType.INVERT },
  };
}

function plainString(name, nullable = false) {
  return { name, dataType: ZVecDataType.STRING, nullable };
}

function legacyFilesSchema() {
  return new ZVecCollectionSchema({
    name: "zvec_grep_files",
    fields: [
      indexedString("file_id"),
      indexedString("absolute_path"),
      plainString("relative_path"),
      plainString("root_path"),
      { name: "size_bytes", dataType: ZVecDataType.INT64, nullable: false },
      {
        name: "last_modified_time",
        dataType: ZVecDataType.INT64,
        nullable: false,
      },
      indexedString("content_hash", true),
      indexedString("kind"),
      indexedString("format"),
      { name: "has_index_status", dataType: ZVecDataType.BOOL, nullable: false },
      { name: "indexed_time", dataType: ZVecDataType.INT64, nullable: true },
      { name: "entity_count", dataType: ZVecDataType.INT32, nullable: false },
      { name: "token_count", dataType: ZVecDataType.INT32, nullable: true },
      {
        name: "truncated_fragment_count",
        dataType: ZVecDataType.INT32,
        nullable: true,
      },
      plainString("error", true),
      plainString("entity_ids_json"),
    ],
  });
}

// Build a legacy (v1) index home from a real v2 index: identical content in
// the legacy absolute-path format, including a persisted credential/device.
async function buildLegacyHome(v2Root, legacyHome, indexId) {
  const v2Paths = resolveWorkspaceIndexStoragePaths(join(v2Root, ".zvec-grep"));
  const srcFiles = ZVecOpen(v2Paths.filesPath, { readOnly: true });
  const srcEntities = ZVecOpen(v2Paths.indexPath, { readOnly: true });
  const fileDocs = [...srcFiles.iterDocsSync({ includeVector: false })];
  const entityDocs = [...srcEntities.iterDocsSync({ includeVector: true })];

  const legacyPaths = resolveWorkspaceIndexStoragePaths(legacyHome);
  mkdir(legacyPaths.storagePath, { recursive: true });
  const dstFiles = ZVecCreateAndOpen(legacyPaths.filesPath, legacyFilesSchema());
  const dstEntities = ZVecCreateAndOpen(
    legacyPaths.indexPath,
    createEntitiesSchema(EMBEDDING),
  );

  const legacyFileIds = new Map();
  for (const doc of fileDocs) {
    const absolutePath = join(v2Root, doc.fields.canonical_path);
    legacyFileIds.set(doc.id, oldFileId(indexId, absolutePath));
  }
  const legacyFragmentIds = new Map();
  for (const doc of entityDocs) {
    const oldFile = legacyFileIds.get(String(doc.fields.file_id));
    legacyFragmentIds.set(
      doc.id,
      oldFragmentId(oldFile, Number(doc.fields.fragment_index)),
    );
  }

  for (const doc of fileDocs) {
    const absolutePath = join(v2Root, doc.fields.canonical_path);
    const entityIds = JSON.parse(doc.fields.entity_ids_json).map((id) =>
      legacyFragmentIds.get(id),
    );
    const { canonical_path: _legacyField, ...legacyFields } = doc.fields;
    dstFiles.insertSync({
      id: legacyFileIds.get(doc.id),
      fields: {
        ...legacyFields,
        file_id: legacyFileIds.get(doc.id),
        absolute_path: resolve(absolutePath),
        root_path: resolve(v2Root),
        entity_ids_json: JSON.stringify(entityIds),
      },
    });
  }
  for (const doc of entityDocs) {
    const group = doc.fields.group;
    dstEntities.insertSync({
      id: legacyFragmentIds.get(doc.id),
      vectors: { embedding: doc.vectors.embedding },
      fields: {
        ...doc.fields,
        file_id: legacyFileIds.get(String(doc.fields.file_id)),
        ...(typeof group === "string" && group.length > 0
          ? { group: legacyFragmentIds.get(group) }
          : {}),
      },
    });
  }
  dstFiles.closeSync();
  dstEntities.closeSync();
  srcFiles.closeSync();
  srcEntities.closeSync();

  await writeFile(
    join(legacyHome, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: indexId,
      name: "legacy-workspace",
      path: legacyHome,
      rootPaths: [{ absolutePath: resolve(v2Root), recursive: true }],
      indexPolicy: "enabled",
      embedding: EMBEDDING,
      indexVersion: 1,
      createdTime: 1000,
      updatedTime: 1000,
      embeddingRuntime: {
        apiKey: "legacy-persisted-secret",
        endpoint: "http://127.0.0.1:9/embeddings",
        device: "metal",
      },
    }),
    { mode: 0o600 },
  );
  return { fileCount: fileDocs.length, entityCount: entityDocs.length };
}

test("migration converts a legacy index preserving vectors and relationships", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-migrate-");
  const sourceRoot = join(parent, "original");
  await mkdir(join(sourceRoot, "docs"), { recursive: true });
  await mkdir(join(sourceRoot, "src"), { recursive: true });
  for (const [relative, content] of Object.entries(FIXTURES)) {
    await writeFile(join(sourceRoot, relative), content);
  }

  // A real index provides authentic entity content and vectors.
  const model = new FakeEmbeddingModel();
  const service = await createZvecGrep({ root: sourceRoot, embeddingModel: model });
  await service.index();
  await service.close();
  const v2Manifest = readWorkspaceManifest(join(sourceRoot, ".zvec-grep"));

  const legacyHome = join(sourceRoot, ".zvec-grep-legacy");
  const { fileCount, entityCount } = await buildLegacyHome(
    sourceRoot,
    legacyHome,
    v2Manifest.id,
  );
  assert.ok(fileCount >= 2);
  assert.ok(entityCount >= 2);

  // The destination workspace carries the same files but no index yet.
  const destinationRoot = join(parent, "destination");
  await mkdir(destinationRoot, { recursive: true });
  await cp(join(sourceRoot, "docs"), join(destinationRoot, "docs"), {
    recursive: true,
  });
  await cp(join(sourceRoot, "src"), join(destinationRoot, "src"), {
    recursive: true,
  });

  const sourceManifestBefore = await readFile(
    join(legacyHome, "manifest.json"),
    "utf8",
  );
  const result = await migrateWorkspaceIndex({
    sourceHome: legacyHome,
    destinationRoot,
  });

  assert.equal(result.filesConverted, fileCount);
  assert.equal(result.entitiesConverted, entityCount);
  assert.deepEqual(result.missingFiles, []);
  assert.equal(result.droppedPersistedCredential, true);
  assert.equal(result.droppedPersistedDevice, true);
  assert.deepEqual(result.verification, {
    countsMatch: true,
    groupIntegrity: true,
    inventoriesResolve: true,
    vectorsCompared: result.verification.vectorsCompared,
    vectorsExact: true,
  });
  assert.ok(result.verification.vectorsCompared > 0);

  // The migrated index has identical portable identities to a fresh index of
  // the same content: the index UUID and every document ID are preserved.
  const migratedManifest = readWorkspaceManifest(result.destinationHome);
  assert.equal(migratedManifest?.id, v2Manifest.id);
  const destinationPaths = resolveWorkspaceIndexStoragePaths(
    result.destinationHome,
  );
  const referencePaths = resolveWorkspaceIndexStoragePaths(
    join(sourceRoot, ".zvec-grep"),
  );
  const migratedEntities = ZVecOpen(destinationPaths.indexPath, {
    readOnly: true,
  });
  const referenceEntities = ZVecOpen(referencePaths.indexPath, {
    readOnly: true,
  });
  const migratedIds = [
    ...migratedEntities.iterDocsSync({ includeVector: true }),
  ]
    .map((doc) => doc.id)
    .sort();
  const referenceIds = [
    ...referenceEntities.iterDocsSync({ includeVector: true }),
  ]
    .map((doc) => doc.id)
    .sort();
  assert.deepEqual(migratedIds, referenceIds);
  const referenceById = new Map(
    [...referenceEntities.iterDocsSync({ includeVector: true })].map((doc) => [
      doc.id,
      Array.from(doc.vectors.embedding),
    ]),
  );
  for (const doc of [
    ...migratedEntities.iterDocsSync({ includeVector: true }),
  ]) {
    assert.deepEqual(
      Array.from(doc.vectors.embedding),
      referenceById.get(doc.id),
    );
  }
  migratedEntities.closeSync();
  referenceEntities.closeSync();

  // The transfer artifact carries no credential or device.
  const migratedRaw = await readFile(
    join(result.destinationHome, "manifest.json"),
    "utf8",
  );
  assert.ok(!migratedRaw.includes("legacy-persisted-secret"));
  assert.ok(!migratedRaw.includes("metal"));
  assert.equal(
    migratedManifest?.embeddingRuntime.endpoint,
    "http://127.0.0.1:9/embeddings",
  );

  // The source is untouched and still readable.
  assert.equal(
    await readFile(join(legacyHome, "manifest.json"), "utf8"),
    sourceManifestBefore,
  );
  const legacyPaths = resolveWorkspaceIndexStoragePaths(legacyHome);
  const legacyEntities = ZVecOpen(legacyPaths.indexPath, { readOnly: true });
  assert.equal(legacyEntities.stats.docCount, entityCount);
  legacyEntities.closeSync();

  // The migrated workspace works end-to-end without re-embedding.
  const modelD = new FakeEmbeddingModel();
  const serviceD = await createZvecGrep({
    root: destinationRoot,
    embeddingModel: modelD,
  });
  const search = await serviceD.context({
    query: "configuration device",
    limit: 5,
  });
  assert.ok(search.items.length > 0);
  for (const item of search.items) {
    assert.ok(
      (item.file?.absolutePath ?? "").startsWith(`${destinationRoot}/`),
      "destination must resolve under the migrated workspace",
    );
  }
  await serviceD.close();
});

test("migration refuses to overwrite an existing destination", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-migrate-guard-");
  const sourceRoot = join(parent, "original");
  await mkdir(join(sourceRoot, "docs"), { recursive: true });
  await writeFile(join(sourceRoot, "docs", "guide.md"), FIXTURES["docs/guide.md"]);
  const service = await createZvecGrep({
    root: sourceRoot,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await service.index();
  await service.close();
  const v2Manifest = readWorkspaceManifest(join(sourceRoot, ".zvec-grep"));

  const legacyHome = join(sourceRoot, ".zvec-grep-legacy");
  await buildLegacyHome(sourceRoot, legacyHome, v2Manifest.id);

  const destinationRoot = join(parent, "destination");
  await mkdir(join(destinationRoot, ".zvec-grep"), { recursive: true });
  const sourceManifestBefore = await readFile(
    join(legacyHome, "manifest.json"),
    "utf8",
  );
  await assert.rejects(
    () =>
      migrateWorkspaceIndex({
        sourceHome: legacyHome,
        destinationRoot,
      }),
    /Destination already contains a workspace index/,
  );
  assert.equal(
    await readFile(join(legacyHome, "manifest.json"), "utf8"),
    sourceManifestBefore,
  );
  // No staging directory is left behind.
  const leftovers = await import("node:fs/promises").then((fs) =>
    fs.readdir(destinationRoot),
  );
  assert.deepEqual(leftovers.sort(), [".zvec-grep"]);
});
