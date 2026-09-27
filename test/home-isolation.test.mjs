import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

function bindingStoreDir(home) {
  // An explicit ZVEC_GREP_HOME is the home itself; the default-home
  // resolution places state under HOME/.zvec-grep.
  return join(home, "bindings");
}
async function bindingRootsInStore(storeDir) {
  const names = await readdir(storeDir).catch(() => []);
  const roots = [];
  for (const name of names) {
    const record = JSON.parse(await readFile(join(storeDir, name), "utf8"));
    for (const binding of record.bindings ?? []) {
      roots.push(binding.rootPath ?? null);
    }
  }
  return roots;
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

  const roots = await bindingRootsInStore(bindingStoreDir(isolatedHome));
  assert.ok(
    roots.includes(root),
    "the isolated home must carry a binding for this exact workspace",
  );
  const shadowZvec = await readdir(join(shadowHome, ".zvec-grep")).catch(
    () => null,
  );
  assert.equal(
    shadowZvec,
    null,
    "no zvec-grep state may appear in the shadow user home",
  );
});

test("subprocess CLI inherits the isolated home, executes, and records the exact workspace", async (t) => {
  const root = await makeWorkspace("subprocess");
  const isolatedHome = await mkdtemp(join(tmpdir(), "zg-home-iso-sub-home-"));
  const shadowHome = await mkdtemp(join(tmpdir(), "zg-home-iso-sub-shadow-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(isolatedHome, { recursive: true, force: true });
    await rm(shadowHome, { recursive: true, force: true });
  });

  // A missing CLI or any execution failure must fail this test: the index
  // command is required to succeed against the controlled fixture.
  await execFileAsync(
    process.execPath,
    [cliPath, "--index", root, "--embedding", "local/all-minilm-l6-v2"],
    {
      env: {
        ...process.env,
        ZVEC_GREP_HOME: isolatedHome,
        HOME: shadowHome,
        ZVEC_GREP_MODEL_CACHE: isolatedHome,
      },
    },
  );

  const roots = await bindingRootsInStore(bindingStoreDir(isolatedHome));
  assert.ok(
    roots.includes(root),
    "the isolated home must carry a binding for this exact workspace",
  );
  const shadowZvec = await readdir(join(shadowHome, ".zvec-grep")).catch(
    () => null,
  );
  assert.equal(
    shadowZvec,
    null,
    "no zvec-grep state may appear in the shadow user home",
  );
});

test("unset override writes to a disposable shadow home, never production", async (t) => {
  const root = await makeWorkspace("unset");
  const shadowHome = await mkdtemp(join(tmpdir(), "zg-home-iso-unset-shadow-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(shadowHome, { recursive: true, force: true });
  });

  // Delete the override from the child environment only; the parent's
  // environment (including any suite-level isolation) is untouched.
  const childEnv = { ...process.env };
  delete childEnv.ZVEC_GREP_HOME;
  childEnv.HOME = shadowHome;
  childEnv.ZVEC_GREP_MODEL_CACHE = shadowHome;

  await execFileAsync(
    process.execPath,
    [cliPath, "--index", root, "--embedding", "local/all-minilm-l6-v2"],
    { env: childEnv },
  );

  const roots = await bindingRootsInStore(
    join(shadowHome, ".zvec-grep", "bindings"),
  );
  assert.ok(
    roots.includes(root),
    "the disposable shadow home must carry a binding for this exact workspace",
  );
});
