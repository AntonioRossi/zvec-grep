import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ZVecInitialize, ZVecLogLevel } from "@zvec/zvec";
import { readWorkspaceManifest } from "../../dist/engine/manifest.js";
import { exportWorkspaceIndex } from "../../dist/engine/transfer/index.js";
import { createZvecGrep } from "../../dist/index.js";
import { CountingEmbeddingModel } from "../helpers/counting-embedding.mjs";
import { createTemporaryDirectory } from "../helpers/fixtures.mjs";
import { FakeEmbeddingModel } from "../helpers/fake-embedding.mjs";
import { useIsolatedZvecGrepHome } from "../helpers/isolated-home.mjs";
import { buildLegacyHome } from "../helpers/legacy-index.mjs";

useIsolatedZvecGrepHome();

const execFileAsync = promisify(execFile);
const CLI = resolve("dist/cli/index.js");

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
    "## Operations",
    "",
    "Refresh the index after large imports of new material.",
    "",
  ].join("\n"),
  "src/util.ts": [
    "export function normalizeEndpoint(value: string): string {",
    "  return value.trim().toLowerCase();",
    "}",
    "",
  ].join("\n"),
};

async function makeSourceWorkspace(parent) {
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
  return sourceRoot;
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

async function importInSeparateProcess(artifactPath, destinationRoot, t) {
  const resultPath = join(
    await createTemporaryDirectory(t, "zg-transfer-result-"),
    "result.json",
  );
  const script = `
    import { writeFileSync } from "node:fs";
    import { importWorkspaceIndex } from ${JSON.stringify(
      `file://${resolve("dist/engine/transfer/index.js")}`,
    )};
    const result = await importWorkspaceIndex({
      artifactPath: ${JSON.stringify(artifactPath)},
      destinationRoot: ${JSON.stringify(destinationRoot)},
      onProgress: (stage, detail) => console.error(stage + ": " + detail),
    });
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
  `;
  // The child must exit successfully and leave a fresh, completely validated
  // result file; stdout is not part of the exchange.
  const started = Date.now();
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    timeout: 120_000,
  });
  const raw = JSON.parse(await readFile(resultPath, "utf8"));
  const resultStat = await stat(resultPath);
  assert.ok(
    resultStat.mtimeMs >= started,
    "the child must leave a fresh result file",
  );
  for (const field of [
    "destinationHome",
    "indexId",
    "filesImported",
    "entitiesImported",
    "missingFiles",
    "verification",
  ]) {
    assert.ok(field in raw, `result file is missing ${field}`);
  }
  return raw;
}

test("exported v2 index imports in a separate process with source unavailable", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-transfer-v2-");
  const sourceRoot = await makeSourceWorkspace(parent);
  const sourceHome = join(sourceRoot, ".zvec-grep");
  const artifact = join(parent, "artifact");

  const exported = await exportWorkspaceIndex({
    sourceHome,
    artifactPath: artifact,
  });
  assert.ok(exported.entitiesExported > 0);

  // The source index is made unavailable before import.
  await rename(sourceHome, `${sourceHome}-away`);

  const destinationRoot = join(parent, "destination");
  await copySourceFiles(sourceRoot, destinationRoot);
  const imported = await importInSeparateProcess(artifact, destinationRoot, t);
  assert.equal(imported.verification.countsMatch, true);
  assert.equal(imported.verification.inventoriesExact, true);
  assert.equal(imported.verification.groupIntegrity, true);
  assert.equal(imported.verification.vectorsExact, true);

  // The artifact and imported manifest carry no credentials or host claims.
  const artifactManifest = JSON.parse(
    await readFile(join(artifact, "manifest.json"), "utf8"),
  );
  assert.equal(artifactManifest.embeddingRuntime.apiKey, undefined);
  assert.equal(artifactManifest.embeddingRuntime.device, undefined);
  assert.equal(artifactManifest.rootFingerprint, undefined);

  // The imported workspace searches its own destinations without inference.
  const model = new CountingEmbeddingModel();
  const service = await createZvecGrep({
    root: destinationRoot,
    embeddingModel: model,
  });
  const search = await service.context({
    query: "configuration device",
    limit: 5,
  });
  assert.ok(search.items.length > 0);
  assert.equal(model.counts.document, 0);
  for (const item of search.items) {
    assert.ok(
      (item.file?.absolutePath ?? "").startsWith(`${destinationRoot}/`),
      "destination must resolve under the imported workspace",
    );
  }
  await service.close();
});

test("exported legacy v1 index imports in portable form", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-transfer-v1-");
  const sourceRoot = await makeSourceWorkspace(parent);
  const manifest = readWorkspaceManifest(join(sourceRoot, ".zvec-grep"));
  const legacyHome = join(sourceRoot, ".zvec-grep-legacy");
  await buildLegacyHome(sourceRoot, legacyHome, manifest.id);

  const artifact = join(parent, "artifact");
  const exported = await exportWorkspaceIndex({
    sourceHome: legacyHome,
    artifactPath: artifact,
  });
  assert.ok(exported.entitiesExported > 0);

  const artifactText = await readFile(join(artifact, "manifest.json"), "utf8");
  assert.ok(!artifactText.includes("legacy-persisted-secret"));
  assert.ok(!artifactText.includes("metal"));

  const destinationRoot = join(parent, "destination");
  await copySourceFiles(sourceRoot, destinationRoot);
  const imported = await importInSeparateProcess(artifact, destinationRoot, t);
  assert.equal(imported.verification.vectorsExact, true);
  assert.equal(imported.indexId, manifest.id);

  // The imported (migrated) index is unverified: its first index reconciles.
  const model = new CountingEmbeddingModel();
  const service = await createZvecGrep({
    root: destinationRoot,
    embeddingModel: model,
  });
  const refresh = await service.index();
  assert.equal(refresh.filesFailed, 0);
  assert.equal(
    model.counts.document,
    0,
    "unchanged imported content must not be re-embedded",
  );
  await service.close();
});

test("import rejects a credential-bearing artifact manifest", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-transfer-credential-");
  const sourceRoot = await makeSourceWorkspace(parent);
  const artifact = join(parent, "artifact");
  await exportWorkspaceIndex({
    sourceHome: join(sourceRoot, ".zvec-grep"),
    artifactPath: artifact,
  });

  const manifestPath = join(artifact, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.embeddingRuntime.apiKey = "synthetic-review-secret";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const destinationRoot = join(parent, "destination");
  await copySourceFiles(sourceRoot, destinationRoot);
  await assert.rejects(
    importInSeparateProcess(artifact, destinationRoot, t),
    undefined,
    "a credential-bearing manifest must be rejected",
  );
  assert.equal(
    (await readdir(destinationRoot)).filter((entry) => entry === ".zvec-grep")
      .length,
    0,
    "no destination is published from invalid metadata",
  );
});

test("import rejects internally consistent but underived identities", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-transfer-underived-");
  const sourceRoot = await makeSourceWorkspace(parent);
  const artifact = join(parent, "artifact");
  await exportWorkspaceIndex({
    sourceHome: join(sourceRoot, ".zvec-grep"),
    artifactPath: artifact,
  });

  // Rewrite every identity to be internally consistent (doc id, file_id
  // fields, inventory references, entity ids and file links all agree) but
  // not derived from the portable scheme (index UUID + canonical path).
  const crypto = await import("node:crypto");
  const wrongFileId = crypto
    .createHash("sha256")
    .update("internally-consistent-but-wrong")
    .digest("hex");
  const filesPath = join(artifact, "files.jsonl");
  const entitiesPath = join(artifact, "entities.jsonl");
  const fileDocs = (await readFile(filesPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const entityDocs = (await readFile(entitiesPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  const idByOld = new Map();
  const newFileDocs = fileDocs.map((doc, index) => {
    const wrong = crypto
      .createHash("sha256")
      .update(`wrong-${index}`)
      .digest("hex");
    idByOld.set(doc.id, wrong);
    return {
      ...doc,
      id: wrong,
      fields: { ...doc.fields, file_id: wrong },
    };
  });
  const newEntityDocs = entityDocs.map((doc) => {
    const wrongFile = idByOld.get(String(doc.fields.file_id));
    const wrongId = crypto
      .createHash("sha256")
      .update(`${wrongFile}\0${Number(doc.fields.fragment_index)}`)
      .digest("hex");
    idByOld.set(doc.id, wrongId);
    return {
      ...doc,
      id: wrongId,
      fields: {
        ...doc.fields,
        file_id: wrongFile,
        ...(typeof doc.fields.group === "string" && doc.fields.group
          ? { group: doc.fields.group }
          : {}),
      },
    };
  });
  const remappedEntityDocs = newEntityDocs.map((doc) => ({
    ...doc,
    fields: {
      ...doc.fields,
      ...(typeof doc.fields.group === "string" && doc.fields.group
        ? { group: idByOld.get(doc.fields.group) ?? doc.fields.group }
        : {}),
    },
  }));
  const remappedFileDocs = newFileDocs.map((doc) => ({
    ...doc,
    fields: {
      ...doc.fields,
      entity_ids_json: JSON.stringify(
        JSON.parse(doc.fields.entity_ids_json).map((id) => idByOld.get(id) ?? id),
      ),
    },
  }));
  await writeFile(
    filesPath,
    remappedFileDocs.map((doc) => JSON.stringify(doc)).join("\n") + "\n",
  );
  await writeFile(
    entitiesPath,
    remappedEntityDocs.map((doc) => JSON.stringify(doc)).join("\n") + "\n",
  );

  const destinationRoot = join(parent, "destination");
  await copySourceFiles(sourceRoot, destinationRoot);
  await assert.rejects(
    importInSeparateProcess(artifact, destinationRoot, t),
    undefined,
    "internally consistent but underived identities must be rejected",
  );
});

test("CLI migrate requires an explicit destination and CLI export/import works", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-transfer-cli-");

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [CLI, "--migrate-index", join(parent, "some-legacy-home")],
      { timeout: 60_000 },
    ),
    /requires a legacy index home and an explicit destination/,
  );

  const sourceRoot = await makeSourceWorkspace(parent);
  const artifact = join(parent, "cli-artifact");
  const destinationRoot = join(parent, "cli-destination");
  await copySourceFiles(sourceRoot, destinationRoot);
  const env = { ...process.env, ZVEC_GREP_HOME: process.env.ZVEC_GREP_HOME };

  await execFileAsync(
    process.execPath,
    [CLI, "--export-index", join(sourceRoot, ".zvec-grep"), artifact],
    { timeout: 120_000, env },
  );
  await rename(join(sourceRoot, ".zvec-grep"), `${sourceRoot}/.zvec-grep-away`);
  await execFileAsync(
    process.execPath,
    [CLI, "--import-index", artifact, destinationRoot],
    { timeout: 120_000, env },
  );

  const manifest = readWorkspaceManifest(join(destinationRoot, ".zvec-grep"));
  assert.ok(manifest?.embedding);
});
