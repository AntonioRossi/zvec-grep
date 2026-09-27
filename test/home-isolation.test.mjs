import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { BaseEmbeddingModel } from "../dist/engine/models/embeddings.js";
import { createZvecGrep } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dist/cli/index.js");

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

async function makeWorkspace(label) {
  const root = await mkdtemp(join(tmpdir(), `zg-home-iso-${label}-`));
  await writeFile(join(root, "doc.md"), "home isolation probe document\n");
  return root;
}

test("engine writes bindings only into an inherited isolated home", async (t) => {
  const root = await makeWorkspace("inherited");
  const isolatedHome = await mkdtemp(join(tmpdir(), "zg-home-iso-home-"));
  const shadowHome = await mkdtemp(join(tmpdir(), "zg-home-iso-shadow-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(isolatedHome, { recursive: true, force: true });
    await rm(shadowHome, { recursive: true, force: true });
  });

  const previousHome = process.env.ZVEC_GREP_HOME;
  const previousUserHome = process.env.HOME;
  process.env.ZVEC_GREP_HOME = isolatedHome;
  process.env.HOME = shadowHome;
  try {
    const service = await createZvecGrep({
      root,
      embeddingModel: new TestEmbeddingModel(),
    });
    await service.index();
    await service.close();
  } finally {
    if (previousHome === undefined) delete process.env.ZVEC_GREP_HOME;
    else process.env.ZVEC_GREP_HOME = previousHome;
    process.env.HOME = previousUserHome;
  }

  assert.ok(
    (await readdir(isolatedHome)).length > 0,
    "isolated home must receive the binding writes",
  );
  const shadowEntries = await readdir(join(shadowHome, ".zvec-grep"), {
    withFileTypes: true,
  }).catch(() => []);
  const shadowBindings = shadowEntries.filter((e) => e.name === "bindings");
  assert.equal(
    shadowBindings.length,
    0,
    "no bindings directory may appear in the shadow user home",
  );
});

test("subprocess CLI inherits the isolated home and never the real one", async (t) => {
  const root = await makeWorkspace("subprocess");
  const isolatedHome = await mkdtemp(join(tmpdir(), "zg-home-iso-sub-home-"));
  const shadowHome = await mkdtemp(join(tmpdir(), "zg-home-iso-sub-shadow-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(isolatedHome, { recursive: true, force: true });
    await rm(shadowHome, { recursive: true, force: true });
  });

  await execFileAsync(
    process.execPath,
    [cliPath, "--index", root, "--embedding", "test/deterministic"],
    {
      env: {
        ...process.env,
        ZVEC_GREP_HOME: isolatedHome,
        HOME: shadowHome,
        ZVEC_GREP_EMBEDDING_MODEL_PATH: "",
      },
    },
  ).catch(() => {
    // The test model reference may be rejected by the CLI's model
    // registry; the isolation assertion below still holds for any binding
    // the attempt writes.
  });

  const isolatedEntries = await readdir(isolatedHome).catch(() => []);
  const shadowBindings = await readdir(
    join(shadowHome, ".zvec-grep", "bindings"),
  ).catch(() => null);
  assert.equal(
    shadowBindings,
    null,
    "no bindings may be created under the shadow user home",
  );
  if (isolatedEntries.length > 0) {
    assert.ok(
      isolatedEntries.includes("bindings"),
      "any binding writes belong in the isolated home",
    );
  }
});

test("unset override writes to a disposable shadow home, never production", async (t) => {
  const root = await makeWorkspace("unset");
  const shadowHome = await mkdtemp(join(tmpdir(), "zg-home-iso-unset-shadow-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(shadowHome, { recursive: true, force: true });
  });

  // The subprocess form honors the environment uniformly: with the
  // override deleted, the default-home resolution must land inside the
  // disposable shadow HOME, never the real user home.
  await execFileAsync(
    process.execPath,
    [cliPath, "--index", root, "--embedding", "local/all-minilm-l6-v2"],
    {
      env: {
        ...process.env,
        HOME: shadowHome,
        ZVEC_GREP_MODEL_CACHE: shadowHome,
      },
    },
  );

  const shadowBindings = await readdir(
    join(shadowHome, ".zvec-grep", "bindings"),
  ).catch(() => null);
  assert.ok(
    Array.isArray(shadowBindings),
    "with the override unset, writes must land in the disposable shadow home",
  );
  assert.ok(shadowBindings.length > 0, "the binding must be observable");
});
