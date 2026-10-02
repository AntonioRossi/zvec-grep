// Portability matrix probe — RELOCATION scenario (macos-latest workflow).
// Review-branch-only successor of the round-27 probe at 7e73b30, repaired
// per work order §13 item 4: the reopened manifest identity must equal the
// source identity, the relocated query must hit the relocated file at the
// relocated root, zero document re-embeddings may occur at reopen, and the
// removed source must be gone entirely. Fault-injection controls
// (PORT_PROBE_INJECT) demonstrate each assertion bites.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INJECT = process.env.PORT_PROBE_INJECT ?? "";
const repo = fileURLToPath(new URL("../", import.meta.url));
const { createZvecGrep } = await import(join(repo, "dist/index.js"));
const { readWorkspaceManifest } = await import(
  join(repo, "dist/engine/manifest.js")
);
const { CountingEmbeddingModel } = await import(
  join(repo, "test/helpers/counting-embedding.mjs")
);

const base = await mkdtemp(join(tmpdir(), "port-relocation-"));
const home = join(base, "home");
const A = join(base, "A");
const B = join(base, "B");
process.env.ZVEC_GREP_HOME = home;
await mkdir(A, { recursive: true });
await mkdir(join(home, ".zvec-grep"), { recursive: true });
await writeFile(
  join(A, "guide.md"),
  "# Guide\n\nThe relocation probe expects the relocated index to rebind to the new root and serve queries without reindexing.\n",
);

const model = new CountingEmbeddingModel();
const serviceA = await createZvecGrep({ root: A, embeddingModel: model });
await serviceA.index();
await serviceA.close();
const manifestA = readWorkspaceManifest(join(A, ".zvec-grep"));
assert.ok(manifestA?.id, "workspace identity present after index");

// Relocate A -> B (workspace plus its .zvec-grep), then remove A entirely.
await cp(A, B, { recursive: true, preserveTimestamps: true });
await rm(A, { recursive: true, force: true });
await assert.rejects(stat(join(A, ".zvec-grep")), { code: "ENOENT" });
await assert.rejects(stat(A), { code: "ENOENT" });
if (INJECT === "empty-index") {
  await rm(join(B, ".zvec-grep", "index.zvec"), {
    recursive: true,
    force: true,
  });
}
if (INJECT === "stale-identity") {
  const manifestPath = join(B, ".zvec-grep", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.id = "00000000-0000-4000-8000-000000000000";
  await writeFile(manifestPath, JSON.stringify(manifest));
}
if (INJECT === "fresh-index") {
  await rm(join(B, ".zvec-grep"), { recursive: true, force: true });
}

// Reopen at B: the portability contribution must rebind rather than fail.
const modelB = new CountingEmbeddingModel();
const serviceB = await createZvecGrep({ root: B, embeddingModel: modelB });
const manifestB = readWorkspaceManifest(join(B, ".zvec-grep"));
assert.equal(
  manifestB?.id,
  manifestA.id,
  "reopened workspace identity must equal the source identity",
);
const contextB = await serviceB.context({
  query: "relocation probe expects",
  route: "fts",
  autoUpdate: false,
});
if (INJECT === "reembed") {
  await writeFile(
    join(B, "guide.md"),
    "# Guide\n\nChanged content forces real embedding work on reindex.\n",
  );
  await serviceB.index();
}
await serviceB.close();
// Item paths may carry the resolved spelling of the relocated root
// (macOS /var vs /private/var); containment is physical.
const realB = realpathSync(B);
assert.ok(contextB.items?.length > 0, "relocated query must hit");
assert.ok(
  contextB.items.every((item) =>
    item.file.absolutePath.startsWith(realB + "/"),
  ),
  "hits must come from the relocated root only",
);
assert.equal(
  modelB.counts.document,
  0,
  "reopen must not re-embed any document",
);
console.log(
  JSON.stringify({
    scenario: "relocation",
    identity: manifestA.id,
    reopenedIdentity: manifestB.id,
    hits: contextB.items.length,
    documentEmbeddingsAtReopen: modelB.counts.document,
    note: "same-machine relocation; cross-machine fidelity is a recorded residual",
  }),
);
await rm(base, { recursive: true, force: true });
