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
const childScript = resolve("test/helpers/home-isolation-child.mjs");

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

// Invoke the child fixture that imports the application and indexes with
// the deterministic test model; the child's exit status propagates and any
// failure fails the test. Home selection comes from the child environment.
async function runChild(env) {
  const { stdout } = await execFileAsync(process.execPath, [childScript], {
    env,
  });
  return JSON.parse(stdout.trim().split("\n").pop());
}

// Read binding records from either an explicit home (bindings/ at the top
// level) or a default-home resolution (.zvec-grep/bindings under HOME).
async function bindingRootsFromStore(storeDir) {
  const names = await readdir(storeDir).catch(() => []);
  const { readFile } = await import("node:fs/promises");
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

  const roots = await bindingRootsFromStore(join(isolatedHome, "bindings"));
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

test("child inherits the isolated home, executes, and records the exact workspace", async (t) => {
  const isolatedHome = await mkdtemp(join(tmpdir(), "zg-home-iso-sub-home-"));
  const shadowHome = await mkdtemp(join(tmpdir(), "zg-home-iso-sub-shadow-"));
  t.after(async () => {
    await rm(isolatedHome, { recursive: true, force: true });
    await rm(shadowHome, { recursive: true, force: true });
  });

  // A missing child or any execution failure fails this test via
  // execFileAsync rejection. The child exercises the real binding-store
  // code path with the deterministic test model — no network.
  const result = await runChild({
    ...process.env,
    ZVEC_GREP_HOME: isolatedHome,
    HOME: shadowHome,
  });
  assert.ok(result.ok, "the child fixture must succeed");

  const roots = await bindingRootsFromStore(join(isolatedHome, "bindings"));
  assert.ok(
    roots.includes(result.root),
    "the isolated home must carry a binding for the child's exact workspace",
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
  const shadowHome = await mkdtemp(join(tmpdir(), "zg-home-iso-unset-shadow-"));
  t.after(async () => {
    await rm(shadowHome, { recursive: true, force: true });
  });

  // Delete the override from the child environment only; the parent's
  // environment is untouched. The child's binding-store resolution must
  // fall back to HOME/.zvec-grep inside the disposable shadow.
  const childEnv = { ...process.env };
  delete childEnv.ZVEC_GREP_HOME;
  childEnv.HOME = shadowHome;

  const result = await runChild(childEnv);
  assert.ok(result.ok, "the child fixture must succeed");

  const roots = await bindingRootsFromStore(
    join(shadowHome, ".zvec-grep", "bindings"),
  );
  assert.ok(
    roots.includes(result.root),
    "the disposable shadow home must carry a binding for the child's exact workspace",
  );
});
