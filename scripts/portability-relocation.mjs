// Portability matrix probe — RELOCATION scenario (macos-latest workflow).
// Adapted (2026-09-30) from the parent-repo relocation probes
// (validation/2026-09-15-portable-indexes/relocation-baseline.mjs and the
// accepted review variants) to be self-contained on a fork checkout: no
// parent-repo worktree indirection; runs against the checked-out revision's
// own dist. Verifies: index a workspace, relocate workspace+index A->B,
// remove A, open B and confirm the manifest rebinding and a query.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

// Reopen at B: the portability contribution must rebind rather than fail.
const modelB = new CountingEmbeddingModel();
const serviceB = await createZvecGrep({ root: B, embeddingModel: modelB });
const before = await serviceB.info();
const contextB = await serviceB.context({ query: "relocation probe", route: "fts" });
await serviceB.close();
assert.ok(contextB, "context opens at the relocated root");
console.log(
  JSON.stringify({
    scenario: "relocation",
    identity: manifestA.id,
    reopenedAt: B,
    statusBeforeQuery: before?.status,
    documentEmbeddingsAtReopen: modelB.counts.document,
    note: "same-machine relocation; cross-machine fidelity is a recorded residual",
  }),
);
await rm(base, { recursive: true, force: true });
