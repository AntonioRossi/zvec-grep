import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ZVecInitialize, ZVecLogLevel, ZVecOpen } from "@zvec/zvec";
import { readWorkspaceManifest } from "../../dist/engine/manifest.js";
import { migrateWorkspaceIndex } from "../../dist/engine/migrate/index.js";
import { resolveWorkspaceIndexStoragePaths } from "../../dist/engine/storage/layout.js";
import { createZvecGrep } from "../../dist/index.js";
import { CountingEmbeddingModel } from "../helpers/counting-embedding.mjs";
import { createTemporaryDirectory } from "../helpers/fixtures.mjs";
import { FakeEmbeddingModel } from "../helpers/fake-embedding.mjs";
import { useIsolatedZvecGrepHome } from "../helpers/isolated-home.mjs";
import { buildLegacyHome } from "../helpers/legacy-index.mjs";

useIsolatedZvecGrepHome();

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

async function makeSourceWorkspace(t, parent) {
  const sourceRoot = join(parent, "original");
  await mkdir(join(sourceRoot, "docs"), { recursive: true });
  await mkdir(join(sourceRoot, "src"), { recursive: true });
  for (const [relative, content] of Object.entries(FIXTURES)) {
    await writeFile(join(sourceRoot, relative), content);
  }
  const service = await createZvecGrep({
    root: sourceRoot,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await service.index();
  await service.close();
  const manifest = readWorkspaceManifest(join(sourceRoot, ".zvec-grep"));
  return { sourceRoot, manifest };
}

async function copySourceFiles(sourceRoot, destinationRoot) {
  await mkdir(destinationRoot, { recursive: true });
  await cp(join(sourceRoot, "docs"), join(destinationRoot, "docs"), {
    recursive: true,
  });
  await cp(join(sourceRoot, "src"), join(destinationRoot, "src"), {
    recursive: true,
  });
}

function fdCount() {
  return readdirSync("/proc/self/fd").length;
}

test("migration converts a legacy index preserving vectors and relationships", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-migrate-");
  const { sourceRoot, manifest } = await makeSourceWorkspace(t, parent);
  const legacyHome = join(sourceRoot, ".zvec-grep-legacy");
  const { fileCount, entityCount } = await buildLegacyHome(
    sourceRoot,
    legacyHome,
    manifest.id,
  );
  assert.ok(fileCount >= 2);
  assert.ok(entityCount >= 2);

  const destinationRoot = join(parent, "destination");
  await copySourceFiles(sourceRoot, destinationRoot);

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
  assert.equal(result.verification.countsMatch, true);
  assert.equal(result.verification.identitiesUnique, true);
  assert.equal(result.verification.ownershipValid, true);
  assert.equal(result.verification.inventoriesExact, true);
  assert.equal(result.verification.groupIntegrity, true);
  assert.equal(result.verification.vectorsExact, true);
  assert.ok(result.verification.vectorsCompared > 0);

  const migratedManifest = readWorkspaceManifest(result.destinationHome);
  assert.equal(migratedManifest?.id, manifest.id);
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

  assert.equal(
    await readFile(join(legacyHome, "manifest.json"), "utf8"),
    sourceManifestBefore,
  );
  const legacyPaths = resolveWorkspaceIndexStoragePaths(legacyHome);
  const legacyEntities = ZVecOpen(legacyPaths.indexPath, { readOnly: true });
  assert.equal(legacyEntities.stats.docCount, entityCount);
  legacyEntities.closeSync();

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

test("migrated index is unverified: first index reconciles same-stat edits", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-migrate-reconcile-");
  const { sourceRoot, manifest } = await makeSourceWorkspace(t, parent);
  const legacyHome = join(sourceRoot, ".zvec-grep-legacy");
  await buildLegacyHome(sourceRoot, legacyHome, manifest.id);

  const destinationRoot = join(parent, "destination");
  await copySourceFiles(sourceRoot, destinationRoot);
  await migrateWorkspaceIndex({ sourceHome: legacyHome, destinationRoot });

  // Same size, same mtime, different content at the destination.
  const target = join(destinationRoot, "docs", "guide.md");
  const indexedStat = await stat(target);
  const original = await readFile(target, "utf8");
  const replaced = original.replace("Configuration", "CONFIGURATION");
  assert.equal(replaced.length, original.length);
  await writeFile(target, replaced);
  await utimes(target, indexedStat.atime, indexedStat.mtime);

  const model = new CountingEmbeddingModel();
  const service = await createZvecGrep({
    root: destinationRoot,
    embeddingModel: model,
  });
  const result = await service.index();
  assert.ok(
    result.filesModified >= 1,
    `migrated index must reconcile content on first index, got ${JSON.stringify(
      { modified: result.filesModified },
    )}`,
  );
  await service.close();
});

test("migration rejects a cross-file inventory", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-migrate-corrupt-");
  const { sourceRoot, manifest } = await makeSourceWorkspace(t, parent);
  const legacyHome = join(sourceRoot, ".zvec-grep-legacy");
  await buildLegacyHome(sourceRoot, legacyHome, manifest.id, {
    mutateInventory: (entityIds, { legacyFragmentIds }) => [
      // Point one file's inventory at the other file's public fragment.
      [...legacyFragmentIds.values()][0],
      ...entityIds.slice(1),
    ],
  });

  const destinationRoot = join(parent, "destination");
  await copySourceFiles(sourceRoot, destinationRoot);
  await assert.rejects(
    () =>
      migrateWorkspaceIndex({
        sourceHome: legacyHome,
        destinationRoot,
      }),
    /failed verification|inventoriesExact.*false/i,
  );
  assert.deepEqual(await readdir(destinationRoot), ["docs", "src"]);
});

test("migration cleans up handles and staging after interruption, and retries", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-migrate-interrupt-");
  const { sourceRoot, manifest } = await makeSourceWorkspace(t, parent);
  const legacyHome = join(sourceRoot, ".zvec-grep-legacy");
  await buildLegacyHome(sourceRoot, legacyHome, manifest.id);

  const destinationRoot = join(parent, "destination");
  await copySourceFiles(sourceRoot, destinationRoot);

  const fdsBefore = fdCount();
  await assert.rejects(() =>
    migrateWorkspaceIndex({
      sourceHome: legacyHome,
      destinationRoot,
      onProgress: (stage) => {
        if (stage === "write") {
          throw new Error("injected interruption");
        }
      },
    }),
  );
  assert.equal(fdCount(), fdsBefore, "no native descriptors may leak");
  assert.deepEqual(await readdir(destinationRoot), ["docs", "src"]);

  // The source remains readable, and a retry succeeds.
  const legacyPaths = resolveWorkspaceIndexStoragePaths(legacyHome);
  const legacyEntities = ZVecOpen(legacyPaths.indexPath, { readOnly: true });
  assert.ok(legacyEntities.stats.docCount > 0);
  legacyEntities.closeSync();

  const result = await migrateWorkspaceIndex({
    sourceHome: legacyHome,
    destinationRoot,
  });
  assert.equal(result.verification.countsMatch, true);
});

test("migration refuses to overwrite an existing destination", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-migrate-guard-");
  const { sourceRoot, manifest } = await makeSourceWorkspace(t, parent);
  const legacyHome = join(sourceRoot, ".zvec-grep-legacy");
  await buildLegacyHome(sourceRoot, legacyHome, manifest.id);

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
  assert.deepEqual(await readdir(destinationRoot), [".zvec-grep"]);
});
