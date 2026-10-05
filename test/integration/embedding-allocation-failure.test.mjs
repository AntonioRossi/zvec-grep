import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createZvecGrep } from "../../dist/index.js";
import { EngineError } from "../../dist/engine/errors.js";
import { createWorkspaceIndexStorage } from "../../dist/engine/storage/index.js";
import { FakeEmbeddingModel } from "../helpers/fake-embedding.mjs";
import { createTemporaryDirectory } from "../helpers/fixtures.mjs";
import { useIsolatedZvecGrepHome } from "../helpers/isolated-home.mjs";

useIsolatedZvecGrepHome();
function storedEntities(root) {
  const storage = createWorkspaceIndexStorage({
    storagePath: join(root, ".zvec-grep"),
    workspaceRoot: root,
    readOnly: true,
  });
  try {
    return storage
      .listFiles()
      .flatMap((file) =>
        storage.listEntitiesByFile(file.id).map(({ entity }) => entity),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  } finally {
    storage.close();
  }
}
test("F2 a catchable allocation failure preserves existing indexed content", async (t) => {
  const parent = await createTemporaryDirectory(t, "zg-allocation-failure-");
  const root = join(parent, "workspace");
  await mkdir(root);
  const changedPath = join(root, "changed.md");
  await writeFile(changedPath, "# Original\n\noriginal lantern phrase\n");
  await writeFile(join(root, "kept.md"), "# Kept\n\nunchanged harbor phrase\n");
  const originalModel = new FakeEmbeddingModel();
  originalModel.info = { ...originalModel.info, provider: "local" };
  let service = await createZvecGrep({ root, embeddingModel: originalModel });
  t.after(() => service?.close());
  await service.index();
  await service.close();
  service = undefined;
  const before = storedEntities(root);
  assert.equal(before.length, 2);
  await writeFile(changedPath, "# Changed\n\nreplacement beacon phrase\n");
  const model = new FakeEmbeddingModel();
  model.info = { ...model.info, provider: "local" };
  model.doEmbed = async () => {
    throw new EngineError("llama.cpp embedding failed", {
      code: "ZVEC_GREP.ENGINE.MODELS.LLAMA_CPP_EMBED_FAILED",
      context:
        "fixture allocation refused; retry with --index-embedding-concurrency 1",
      cause: new EngineError("fixture allocation refused", {
        code: "ZVEC_GREP.ENGINE.MODELS.LLAMA_CPP_CONTEXT_FAILED",
        cause: new Error("fixture GPU allocation refused"),
      }),
    });
  };
  service = await createZvecGrep({ root, embeddingModel: model });
  let failure;
  await assert.rejects(service.index(), (error) => {
    failure = error;
    return true;
  });
  await service.close();
  service = undefined;
  assert.deepEqual(storedEntities(root), before);
  assert.equal(failure.code, "ZVEC_GREP.ENGINE.MODELS.LLAMA_CPP_EMBED_FAILED");
  assert.equal(
    failure.cause.code,
    "ZVEC_GREP.ENGINE.MODELS.LLAMA_CPP_CONTEXT_FAILED",
  );
  assert.match(failure.context, /allocation refused/);
});
