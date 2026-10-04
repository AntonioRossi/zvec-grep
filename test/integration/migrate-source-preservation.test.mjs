import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createZvecGrep } from "../../dist/index.js";
import { migrateWorkspaceIndex } from "../../dist/engine/migrate/index.js";
import { FakeEmbeddingModel } from "../helpers/fake-embedding.mjs";
import { buildLegacyHome } from "../helpers/legacy-index.mjs";
import { useIsolatedZvecGrepHome } from "../helpers/isolated-home.mjs";

useIsolatedZvecGrepHome();

async function hashes(root) {
  const result = {};
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // The operation must create and release its own lock. It must not
      // change any source manifest, collection, vector or native storage byte.
      if (prefix === "" && entry.name === "locks") continue;
      const name = prefix + entry.name;
      if (entry.isDirectory())
        await visit(join(directory, entry.name), name + "/");
      else
        result[name] = createHash("sha256")
          .update(await readFile(join(directory, entry.name)))
          .digest("hex");
    }
  }
  await visit(root);
  return result;
}

test("migration preserves every source native-storage byte while building the destination", async (t) => {
  const parent = await mkdtemp(
    join(tmpdir(), "zg-migrate-source-preservation-"),
  );
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "source");
  const destinationRoot = join(parent, "destination");
  const content = "# Beacon\n\nsealed kernel lantern phrase\n";
  for (const directory of [root, destinationRoot]) {
    await mkdir(directory);
    await writeFile(join(directory, "beacon.md"), content);
  }
  const service = await createZvecGrep({
    root,
    embeddingModel: new FakeEmbeddingModel(),
  });
  try {
    await service.index();
  } finally {
    await service.close();
  }
  const manifest = JSON.parse(
    await readFile(join(root, ".zvec-grep/manifest.json"), "utf8"),
  );
  const sourceHome = join(root, ".legacy");
  await buildLegacyHome(root, sourceHome, manifest.id);
  const before = await hashes(sourceHome);
  assert.ok(
    Object.keys(before).some((name) => name.endsWith(".proxima")),
    "the check must include the native vector index",
  );
  const result = await migrateWorkspaceIndex({
    sourceHome,
    destinationRoot,
    verifySampleLimit: 0,
  });
  assert.equal(result.indexId, manifest.id);
  assert.equal(result.verification.vectorsExact, true);
  assert.equal(result.verification.vectorsSampled, false);
  assert.deepEqual(await hashes(sourceHome), before);
  const locks = await readdir(join(sourceHome, "locks"), { recursive: true });
  assert.ok(
    !locks.some((name) => name.endsWith("lock.json")),
    "the operation must release its source lock",
  );
});
