import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { LlamaCppEmbeddingModel } from "../../../dist/engine/models/backends/llama-cpp.js";
import { createTemporaryDirectory } from "../../helpers/fixtures.mjs";

const GiB = 1024 ** 3;
async function fixture(t, options = {}) {
  const root = await createTemporaryDirectory(t, "zvec-upstream-concurrency-");
  const modelPath = join(root, "test.gguf");
  await writeFile(modelPath, "GGUFpayload");
  const calls = { contexts: 0, estimates: 0, vram: 0, disposed: 0 };
  const fakeModel = {
    gpuLayers: 28,
    get fileInsights() {
      calls.estimates++;
      throw new Error("fork context estimate must not be used");
    },
    createEmbeddingContext: async () => {
      calls.contexts++;
      if (calls.contexts > (options.failAfter ?? Infinity)) {
        throw options.allocationError;
      }
      return {
        getEmbeddingFor: async () => ({ vector: [1, 0] }),
        dispose: async () => {
          calls.disposed++;
        },
      };
    },
  };
  const llama = {
    gpu: options.cpu ? false : "vulkan",
    getVramState: async () => {
      calls.vram++;
      if (options.vramError) throw new Error("counter unavailable");
      return {
        total: 64 * GiB,
        used: 56 * GiB,
        free: options.free ?? 8 * GiB,
      };
    },
    loadModel: async () => fakeModel,
  };
  if (options.noMemoryApi) delete llama.getVramState;
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
      device: options.cpu ? "cpu" : "vulkan",
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

test("F2 llama GPU default follows upstream memory calculation without model estimates", async (t) => {
  for (const contextSize of [8192, 2048]) {
    const setup = await fixture(t, { contextSize });
    await setup.embed();
    assert.equal(setup.calls.contexts, 8);
    assert.equal(setup.calls.estimates, 0);
    assert.equal(setup.calls.vram, 1);
  }
});

test("F2 upstream GPU fallback uses two for failed or invalid memory reads", async (t) => {
  for (const options of [{ vramError: true }, { free: NaN }, { free: -1 }]) {
    const setup = await fixture(t, options);
    await setup.embed();
    assert.equal(setup.calls.contexts, 2);
    assert.equal(setup.calls.estimates, 0);
  }
});

test("F2 upstream CPU and missing-memory-API defaults remain one", async (t) => {
  for (const options of [{ cpu: true }, { noMemoryApi: true }]) {
    const setup = await fixture(t, options);
    await setup.embed();
    assert.equal(setup.calls.contexts, 1);
    assert.equal(setup.calls.vram, 0);
    assert.equal(setup.calls.estimates, 0);
  }
});

test("F2 a partial context allocation failure reports the cause and uses available contexts", async (t) => {
  const messages = [];
  t.mock.method(process.stderr, "write", (message) => {
    messages.push(String(message));
    return true;
  });
  const setup = await fixture(t, {
    override: 2,
    failAfter: 1,
    allocationError: new Error("fixture GPU allocation refused"),
  });
  await setup.embed();
  assert.equal(setup.calls.contexts, 2);
  assert.match(
    messages.join(""),
    /allocation failed.*fixture GPU allocation refused/,
  );
  assert.match(messages.join(""), /continuing with 1 contexts/);
  assert.match(messages.join(""), /--index-embedding-concurrency/);
});

test("F2 a first-context allocation failure preserves the error and recovery hint", async (t) => {
  const allocationError = new Error("fixture allocation refused");
  const setup = await fixture(t, { failAfter: 0, allocationError });
  await assert.rejects(setup.embed(), (error) => {
    assert.equal(error.code, "ZVEC_GREP.ENGINE.MODELS.LLAMA_CPP_EMBED_FAILED");
    assert.equal(
      error.cause.code,
      "ZVEC_GREP.ENGINE.MODELS.LLAMA_CPP_CONTEXT_FAILED",
    );
    assert.equal(error.cause.cause, allocationError);
    assert.match(error.context, /--index-embedding-concurrency 1/);
    return true;
  });
});

test("F2 explicit local concurrency keeps the upstream cap and bypasses memory detection", async (t) => {
  for (const [override, expected] of [
    [2, 2],
    [99, 8],
  ]) {
    const setup = await fixture(t, { override, vramError: true });
    await setup.embed();
    assert.equal(setup.calls.contexts, expected);
    assert.equal(setup.calls.estimates, 0);
    assert.equal(setup.calls.vram, 0);
  }
});
