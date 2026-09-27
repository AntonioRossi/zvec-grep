// Child fixture for home-isolation tests: imports the application and
// indexes using the deterministic test model, letting home selection come
// entirely from the child environment. Exercised via process.execPath so
// the binding-store resolution is the production code path. No network.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseEmbeddingModel } from "../../dist/engine/models/embeddings.js";
import { createZvecGrep } from "../../dist/index.js";

class TestEmbeddingModel extends BaseEmbeddingModel {
  info = {
    reference: "test/deterministic",
    provider: "test",
    name: "deterministic",
    dimension: 16,
    metric: "cosine",
    inputKinds: ["text"],
    limits: { maxBatchSize: 128 },
  };

  async doEmbed(contents) {
    return {
      vectors: contents.map(() => new Array(16).fill(0.1)),
      truncated: [],
    };
  }
}

const root = await mkdtemp(join(tmpdir(), "zg-home-iso-child-"));
await writeFile(join(root, "doc.md"), "home isolation child fixture\n");

let service;
try {
  service = await createZvecGrep({
    root,
    embeddingModel: new TestEmbeddingModel(),
  });
  await service.index();
  console.log(JSON.stringify({ ok: true, root }));
} finally {
  await service?.close();
}
