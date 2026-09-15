import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
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

async function importInSeparateProcess(artifactPath, destinationRoot) {
  const script = `
    import { importWorkspaceIndex } from ${JSON.stringify(
      `file://${resolve("dist/engine/transfer/index.js")}`,
    )};
    const result = await importWorkspaceIndex({
      artifactPath: ${JSON.stringify(artifactPath)},
      destinationRoot: ${JSON.stringify(destinationRoot)},
      onProgress: (stage, detail) => console.error(stage + ": " + detail),
    });
    console.log(JSON.stringify(result));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { timeout: 120_000 },
  );
  return JSON.parse(stdout.trim().split("\n").pop());
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
  const imported = await importInSeparateProcess(artifact, destinationRoot);
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

  const artifactText = await readFile(
    join(artifact, "manifest.json"),
    "utf8",
  );
  assert.ok(!artifactText.includes("legacy-persisted-secret"));
  assert.ok(!artifactText.includes("metal"));

  const destinationRoot = join(parent, "destination");
  await copySourceFiles(sourceRoot, destinationRoot);
  const imported = await importInSeparateProcess(artifact, destinationRoot);
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
