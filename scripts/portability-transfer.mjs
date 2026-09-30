// Portability matrix probe — TRANSFER scenario (macos-latest workflow).
// Adapted (2026-09-30) from the parent-repo transfer-process-proof
// (validation/2026-09-19-portable-indexes-review/transfer-process-proof.mjs)
// to be self-contained on a fork checkout: no parent-repo worktree gitdir
// indirection and no pinned head assertion; single-process export/import
// with source removal, artifact roundtrip equality, and reopen-without-
// reindex verification.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const { createZvecGrep } = await import(join(repo, "dist/index.js"));
const {
  exportWorkspaceIndex,
  importWorkspaceIndex,
} = await import(join(repo, "dist/engine/transfer/index.js"));
const { readWorkspaceManifest } = await import(
  join(repo, "dist/engine/manifest.js")
);
const { CountingEmbeddingModel } = await import(
  join(repo, "test/helpers/counting-embedding.mjs")
);

const base = await mkdtemp(join(tmpdir(), "port-transfer-"));
const home = join(base, "home");
const source = join(base, "source");
const destination = join(base, "destination");
process.env.ZVEC_GREP_HOME = home;
await mkdir(source, { recursive: true });
await mkdir(join(home, ".zvec-grep"), { recursive: true });
const rows = async (artifact, name) =>
  (await readFile(join(artifact, name + ".jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
    .sort((a, b) => a.id.localeCompare(b.id));

const paragraph =
  "The security review requires preserved vectors, complete secondary fragments, and isolated source paths. ";
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

const artifact = join(base, "artifact");
await exportWorkspaceIndex({
  sourceHome: join(source, ".zvec-grep"),
  artifactPath: artifact,
});
const entities = await rows(artifact, "entities");
const secondary = entities.filter(
  (d) => d.fields.group && d.fields.group !== d.id,
).length;
assert.ok(secondary > 0, "secondary fragments present in the artifact");

await mkdir(destination);
await cp(join(source, "guide.md"), join(destination, "guide.md"), {
  preserveTimestamps: true,
});
await rm(source, { recursive: true, force: true });

const imported = await importWorkspaceIndex({
  artifactPath: artifact,
  destinationRoot: destination,
  verifySampleLimit: 0,
});
assert.equal(imported.verification.vectorsSampled, false);

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
const contextT = await reopened.context({ query: "transfer probe", route: "fts" });
await reopened.close();
assert.ok(contextT, "context opens after import");
console.log(
  JSON.stringify({
    scenario: "transfer",
    identity: manifest.id,
    entities: entities.length,
    secondary,
    documentEmbeddingsAtReopen: modelB.counts.document,
    note: "same-machine transfer via artifact; true cross-machine transfer, quarantine attributes and notarization are recorded residuals",
  }),
);
await rm(base, { recursive: true, force: true });
