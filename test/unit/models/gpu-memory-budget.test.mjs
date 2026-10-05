import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { LlamaCppEmbeddingModel } from "../../../dist/engine/models/backends/llama-cpp.js";
import { createTemporaryDirectory } from "../../helpers/fixtures.mjs";

const GiB = 1024 ** 3;
async function fixture(t, options = {}) {
  const root = await createTemporaryDirectory(t, "zvec-gpu-budget-");
  const modelPath = join(root, "test.gguf");
  await writeFile(modelPath, "GGUFpayload");
  const calls = { contexts: 0, estimates: [], vram: 0, disposed: 0 };
  const fakeModel = {
    gpuLayers: 28,
    fileInsights: options.unknownEstimate
      ? undefined
      : {
          estimateContextResourceRequirements: (input) => {
            calls.estimates.push(input);
            return {
              gpuVram: options.cost ?? (input.contextSize / 8192) * GiB,
            };
          },
        },
    createEmbeddingContext: async () => {
      calls.contexts++;
      return {
        getEmbeddingFor: async () => ({ vector: [1, 0] }),
        dispose: async () => {
          calls.disposed++;
        },
      };
    },
  };
  const llama = {
    gpu: "vulkan",
    getVramState: async () => {
      calls.vram++;
      if (options.vramError) throw new Error("counter unavailable");
      return {
        total: 64 * GiB,
        used: 56 * GiB,
        free: options.free
          ? options.free(calls)
          : 8 * GiB - calls.contexts * (options.actualCost ?? 0),
      };
    },
    loadModel: async () => fakeModel,
  };
  const model = new LlamaCppEmbeddingModel(
    {
      reference: "local/budget-test",
      provider: "local",
      model: "budget-test",
      uri: "hf:test/model/test.gguf#revision",
      cacheFile: "test.gguf",
      sources: {
        huggingFace: { repo: "test/model", revision: "revision" },
        modelScope: { repo: "test/model", revision: "revision" },
      },
      artifacts: [{ path: "test.gguf", size: 11, sha256: "a".repeat(64) }],
      dimension: 2,
      metric: "cosine",
      format: "qwen3",
      contextSize: options.contextSize ?? 8192,
      maxBatchSize: 8,
    },
    {
      device: "vulkan",
      modelCacheDir: root,
      embeddingConcurrency: options.override,
    },
    {
      loadRuntime: async () => ({ getLlama: async () => llama }),
      resolveArtifacts: async () => ({ paths: { "test.gguf": modelPath } }),
      runtimeState: {
        failedGpuInitModes: new Set(),
        cpuCompatibleFallbackWarningShown: false,
      },
    },
  );
  t.after(() => model.dispose());
  async function embed(count = 8) {
    const result = await model.embed(
      Array.from({ length: count }, (_, i) => ({
        kind: "text",
        text: `document ${i}`,
      })),
      { purpose: "document" },
    );
    assert.equal(result.vectors.length, count);
  }
  return { calls, embed };
}

test("F2 automatic context count uses the model and context estimate with a safety margin", async (t) => {
  const large = await fixture(t);
  await large.embed();
  assert.equal(large.calls.contexts, 1);
  assert.deepEqual(large.calls.estimates, [
    { contextSize: 8192, modelGpuLayers: 28, isEmbeddingContext: true },
  ]);
  const small = await fixture(t, { contextSize: 2048 });
  await small.embed();
  assert.equal(small.calls.contexts, 5);
});

test("F2 missing estimates or memory counters permit only one automatic context", async (t) => {
  for (const options of [
    { unknownEstimate: true },
    { vramError: true },
    { cost: NaN },
    { cost: 0 },
  ]) {
    const setup = await fixture(t, options);
    await setup.embed();
    assert.equal(setup.calls.contexts, 1);
  }
});

test("F2 observed allocation raises an underestimated context cost before another allocation", async (t) => {
  const setup = await fixture(t, { cost: GiB / 8, actualCost: GiB });
  await setup.embed();
  assert.equal(setup.calls.contexts, 1);
  assert.ok(setup.calls.vram >= 3);
});

test("F2 fresh memory checks stop additional contexts when another GPU user consumes memory", async (t) => {
  const setup = await fixture(t, {
    cost: GiB / 4,
    free: ({ vram }) => (vram <= 3 ? 8 * GiB : GiB / 4),
  });
  await setup.embed();
  assert.equal(setup.calls.contexts, 1);
});

test("F2 automatic budget stays bounded across query and indexing batches while explicit concurrency stays available", async (t) => {
  const automatic = await fixture(t);
  await automatic.embed(1);
  await automatic.embed(8);
  await automatic.embed(8);
  assert.equal(automatic.calls.contexts, 1);
  const explicit = await fixture(t, { override: 2, vramError: true });
  await explicit.embed();
  assert.equal(explicit.calls.contexts, 2);
  assert.equal(explicit.calls.estimates.length, 0);
  assert.equal(explicit.calls.vram, 0);
});
