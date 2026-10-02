import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
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
// failure fails the test. The workspace is parent-owned (allocated and
// torn down here); the child receives it as an argument.
async function runChild(env, root) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [childScript, root],
    {
      env,
    },
  );
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
  // Bindings record the workspace's physical root (realpathSync in
  // src/engine/bindings.ts); compare with the same function the writer
  // uses, not the raw spelling, so a symlinked temporary directory
  // (macOS /var, Windows path forms) still matches.
  const expectedRoot = realpathSync(root);
  assert.ok(
    roots.includes(expectedRoot),
    `the isolated home must carry a binding for this exact workspace; recorded=${JSON.stringify(roots)} expected=${expectedRoot}`,
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
  const root = await makeWorkspace("subprocess");
  const isolatedHome = await mkdtemp(join(tmpdir(), "zg-home-iso-sub-home-"));
  const shadowHome = await mkdtemp(join(tmpdir(), "zg-home-iso-sub-shadow-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(isolatedHome, { recursive: true, force: true });
    await rm(shadowHome, { recursive: true, force: true });
  });

  const result = await runChild(
    {
      ...process.env,
      ZVEC_GREP_HOME: isolatedHome,
      HOME: shadowHome,
    },
    root,
  );
  assert.ok(result.ok, "the child fixture must succeed");
  assert.equal(
    result.root,
    root,
    "the child must report the parent-owned workspace",
  );

  const roots = await bindingRootsFromStore(join(isolatedHome, "bindings"));
  const expectedRoot = realpathSync(root);
  assert.ok(
    roots.includes(expectedRoot),
    `the isolated home must carry a binding for the parent-owned workspace; recorded=${JSON.stringify(roots)} expected=${expectedRoot}`,
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

  const childEnv = { ...process.env };
  delete childEnv.ZVEC_GREP_HOME;
  childEnv.HOME = shadowHome;
  if (process.platform === "win32") {
    // Windows resolves the user home from USERPROFILE (node:os.homedir),
    // not from HOME; point both at the shadow so the default-home
    // resolution is the disposable one.
    childEnv.USERPROFILE = shadowHome;
  }

  const result = await runChild(childEnv, root);
  assert.ok(result.ok, "the child fixture must succeed");
  assert.equal(
    result.root,
    root,
    "the child must report the parent-owned workspace",
  );

  const roots = await bindingRootsFromStore(
    join(shadowHome, ".zvec-grep", "bindings"),
  );
  const expectedRoot = realpathSync(root);
  assert.ok(
    roots.includes(expectedRoot),
    `the disposable shadow home must carry a binding for the parent-owned workspace; recorded=${JSON.stringify(roots)} expected=${expectedRoot}`,
  );
});
