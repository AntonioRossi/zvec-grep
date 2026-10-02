// Portability matrix probe — TRANSFER scenario (macos-latest workflow).
// Review-branch-only successor of the round-27 probe at 7e73b30, repaired
// per work order §13 item 4: preparation and import run in separate
// processes (prepare / import-verify phases), the imported manifest
// identity must equal the source identity, the destination query must hit
// at the destination root with zero document re-embeddings, and artifact
// row/vector equality plus source removal stay asserted. Fault-injection
// controls (PORT_PROBE_INJECT) demonstrate each assertion bites.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INJECT = process.env.PORT_PROBE_INJECT ?? "";
const repo = fileURLToPath(new URL("../", import.meta.url));
// Deterministic fixture path: prepare and import-verify run as separate
// processes and must share one fixture; each prepare starts from a clean
// slate. PORT_PROBE_FIXTURE overrides the location for local control runs.
const base =
  process.env.PORT_PROBE_FIXTURE ?? join(tmpdir(), "port-transfer-proof");
const home = join(base, "home");
const source = join(base, "source");
const destination = join(base, "destination");
const artifact = join(base, "artifact");
process.env.ZVEC_GREP_HOME = home;
const rows = async (root, name) =>
  (await readFile(join(root, name + ".jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
    .sort((a, b) => a.id.localeCompare(b.id));

const paragraph =
  "The security review requires preserved vectors, complete secondary fragments, and isolated source paths. ";

if (process.argv[2] === "prepare") {
  const { createZvecGrep } = await import(join(repo, "dist/index.js"));
  const { exportWorkspaceIndex } = await import(
    join(repo, "dist/engine/transfer/index.js")
  );
  const { readWorkspaceManifest } = await import(
    join(repo, "dist/engine/manifest.js")
  );
  const { CountingEmbeddingModel } = await import(
    join(repo, "test/helpers/counting-embedding.mjs")
  );
  await rm(base, { recursive: true, force: true });
  await mkdir(source, { recursive: true });
  await mkdir(join(home, ".zvec-grep"), { recursive: true });
  await writeFile(
    join(source, "guide.md"),
    "# Review\n\n" +
      Array.from(
        { length: 240 },
        (_, i) => `Paragraph ${i}: ${paragraph.repeat(3)}\n`,
      ).join("\n"),
  );
  const model = new CountingEmbeddingModel();
  model.info.limits.maxInputTokens = 256;
  const service = await createZvecGrep({ root: source, embeddingModel: model });
  await service.index();
  await service.close();
  const manifest = readWorkspaceManifest(join(source, ".zvec-grep"));
  assert.ok(manifest?.id, "workspace identity present after index");
  await exportWorkspaceIndex({
    sourceHome: join(source, ".zvec-grep"),
    artifactPath: artifact,
  });
  const entities = await rows(artifact, "entities");
  const secondary = entities.filter(
    (row) => row.fields.group && row.fields.group !== row.id,
  ).length;
  assert.ok(secondary > 0, "secondary fragments present in the artifact");
  await mkdir(destination, { recursive: true });
  await cp(join(source, "guide.md"), join(destination, "guide.md"), {
    preserveTimestamps: true,
  });
  console.log(
    JSON.stringify({
      phase: "prepare",
      identity: manifest.id,
      entities: entities.length,
      secondary,
      documentEmbeddingsAtBuild: model.counts.document,
    }),
  );
  await rm(source, { recursive: true, force: true });
  process.exit(0);
}

if (process.argv[2] !== "import-verify") {
  throw new Error("Expected prepare or import-verify");
}

const { createZvecGrep } = await import(join(repo, "dist/index.js"));
const { exportWorkspaceIndex, importWorkspaceIndex } = await import(
  join(repo, "dist/engine/transfer/index.js")
);
const { readWorkspaceManifest } = await import(
  join(repo, "dist/engine/manifest.js")
);
const { CountingEmbeddingModel } = await import(
  join(repo, "test/helpers/counting-embedding.mjs")
);

await assert.rejects(readFile(join(source, ".zvec-grep", "manifest.json")), {
  code: "ENOENT",
});
const imported = await importWorkspaceIndex({
  artifactPath: artifact,
  destinationRoot: destination,
  verifySampleLimit: 0,
});
assert.equal(imported.verification.vectorsSampled, false);

if (INJECT === "empty-index") {
  await rm(join(imported.destinationHome, "index.zvec"), {
    recursive: true,
    force: true,
  });
}
if (INJECT === "stale-identity") {
  const manifestPath = join(imported.destinationHome, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.id = "00000000-0000-4000-8000-000000000000";
  await writeFile(manifestPath, JSON.stringify(manifest));
}
if (INJECT === "fresh-index") {
  await rm(imported.destinationHome, { recursive: true, force: true });
}

const manifestSource = JSON.parse(
  await readFile(join(artifact, "manifest.json"), "utf8"),
);
const manifestDestination = readWorkspaceManifest(imported.destinationHome);
assert.equal(
  manifestDestination?.id,
  manifestSource.id,
  "imported workspace identity must equal the artifact identity",
);

const roundtrip = join(base, "roundtrip");
await exportWorkspaceIndex({
  sourceHome: imported.destinationHome,
  artifactPath: roundtrip,
});
for (const name of ["files", "entities"]) {
  assert.deepEqual(await rows(roundtrip, name), await rows(artifact, name));
}

const modelB = new CountingEmbeddingModel();
const reopened = await createZvecGrep({
  root: destination,
  embeddingModel: modelB,
});
const contextT = await reopened.context({
  query: "security review requires preserved vectors",
  route: "fts",
  autoUpdate: false,
});
if (INJECT === "reembed") {
  await writeFile(
    join(destination, "guide.md"),
    "# Review\n\nChanged content forces real embedding work on reindex.\n",
  );
  await reopened.index();
}
await reopened.close();
// Item paths may carry the resolved spelling of the destination root
// (macOS /var vs /private/var); containment is physical.
const realDestination = realpathSync(destination);
assert.ok(contextT.items?.length > 0, "destination query must hit");
assert.ok(
  contextT.items.every((item) =>
    item.file.absolutePath.startsWith(realDestination + "/"),
  ),
  "hits must come from the destination root only",
);
assert.equal(
  modelB.counts.document,
  0,
  "reopen must not re-embed any document",
);
console.log(
  JSON.stringify({
    phase: "import-verify",
    identity: manifestDestination.id,
    hits: contextT.items.length,
    entities: (await rows(artifact, "entities")).length,
    allSerializedRecordsAndVectorsEqual: true,
    documentEmbeddingsAtReopen: modelB.counts.document,
  }),
);
await rm(base, { recursive: true, force: true });
