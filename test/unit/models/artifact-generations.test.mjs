import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { resolveModelArtifacts } from "../../../dist/engine/models/artifact-downloader.js";
import { createTemporaryDirectory } from "../../helpers/fixtures.mjs";

const bytes = Buffer.from("verified model artifact");
const corrupt = Buffer.alloc(bytes.length, 120);
const concurrent = Buffer.alloc(bytes.length, 121);
function artifact(path, value = bytes) {
  return {
    path,
    size: value.length,
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}
const model = artifact("model.onnx");
function options(root, overrides = {}) {
  return {
    model: "local/generation-test",
    sources: [
      {
        kind: "huggingface",
        repo: "owner/model",
        revision: "pinned",
        cacheDirectory: root,
      },
    ],
    artifacts: [model],
    lock: { pollMs: 2, staleMs: 10_000, heartbeatMs: 100 },
    ...overrides,
  };
}
async function entries(root, suffix) {
  return (await readdir(root))
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(root, name));
}
async function selected(root) {
  const paths = await entries(root, ".current");
  assert.equal(paths.length, 1);
  return {
    path: paths[0],
    value: JSON.parse(await readFile(paths[0], "utf8")),
  };
}

test("relative cache roots still return absolute generation paths", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-generation-relative-");
  const result = await resolveModelArtifacts(
    options(relative(process.cwd(), root), {
      dependencies: {
        async fetch() {
          return new Response(bytes);
        },
      },
    }),
  );
  assert.ok(isAbsolute(result.directory));
  assert.equal(result.paths[model.path], join(result.directory, model.path));
  assert.deepEqual(await readFile(result.paths[model.path]), bytes);
});

test("preserves another writer immediately before publication and reuses the generation offline", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-generation-writer-");
  const destination = join(root, model.path);
  await writeFile(destination, corrupt);
  let downloads = 0;
  const result = await resolveModelArtifacts(
    options(root, {
      dependencies: {
        async fetch() {
          downloads++;
          return new Response(bytes);
        },
      },
      onProgress(progress) {
        if (progress.downloadedBytes === bytes.length)
          writeFileSync(destination, concurrent);
      },
    }),
  );
  assert.equal(downloads, 1);
  assert.notEqual(result.directory, root);
  assert.equal(result.paths[model.path], join(result.directory, model.path));
  assert.deepEqual(await readFile(destination), concurrent);
  assert.deepEqual(await readFile(result.paths[model.path]), bytes);
  assert.equal(
    (await selected(root)).value.generation,
    basename(result.directory),
  );
  const cached = await resolveModelArtifacts(
    options(root, {
      dependencies: {
        async fetch() {
          assert.fail("selected generation must work offline");
        },
      },
    }),
  );
  assert.equal(cached.directory, result.directory);
});

test("copies reusable mapped files without sharing their mutable predecessor", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-generation-copy-");
  const tokenizerBytes = Buffer.from("valid tokenizer");
  const tokenizer = artifact("tokenizer.json", tokenizerBytes);
  const localPaths = {
    [model.path]: "onnx/model.onnx",
    [tokenizer.path]: "tokenizer/tokenizer.json",
  };
  await mkdir(join(root, "tokenizer"));
  const original = join(root, localPaths[tokenizer.path]);
  await writeFile(original, tokenizerBytes);
  const base = options(root);
  const requests = [];
  const result = await resolveModelArtifacts({
    ...base,
    sources: [{ ...base.sources[0], localPaths }],
    artifacts: [tokenizer, model],
    dependencies: {
      async fetch(url) {
        requests.push(url);
        await writeFile(original, Buffer.alloc(tokenizerBytes.length, 120));
        return new Response(bytes);
      },
    },
  });
  assert.equal(requests.length, 1);
  assert.ok(requests[0].endsWith("/model.onnx"));
  assert.equal(
    result.paths[tokenizer.path],
    join(result.directory, localPaths[tokenizer.path]),
  );
  assert.deepEqual(
    await readFile(result.paths[tokenizer.path]),
    tokenizerBytes,
  );
  assert.deepEqual(
    await readFile(original),
    Buffer.alloc(tokenizerBytes.length, 120),
  );
  assert.deepEqual(await readFile(result.paths[model.path]), bytes);
});

test("failed repair retains the selection and an open predecessor, then repairs to another generation", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-generation-retain-");
  const tokenizer = artifact("tokenizer.json", Buffer.from("{}"));
  const base = options(root, { artifacts: [model, tokenizer] });
  const fetch = async (url) =>
    new Response(url.endsWith("tokenizer.json") ? "{}" : bytes);
  const first = await resolveModelArtifacts({
    ...base,
    dependencies: { fetch },
  });
  const selection = await selected(root);
  const predecessor = await open(first.paths[tokenizer.path], "r");
  t.after(() => predecessor.close());
  await writeFile(first.paths[model.path], corrupt);
  await assert.rejects(
    resolveModelArtifacts({
      ...base,
      dependencies: {
        async fetch() {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes.subarray(0, 3));
                controller.error(new Error("interrupted"));
              },
            }),
          );
        },
      },
    }),
    (error) => error.kind === "network",
  );
  assert.deepEqual(await selected(root), selection);
  const [container] = await entries(root, ".generations");
  assert.deepEqual(await readdir(container), [basename(first.directory)]);
  const repaired = await resolveModelArtifacts({
    ...base,
    dependencies: { fetch },
  });
  assert.notEqual(repaired.directory, first.directory);
  assert.deepEqual(await readFile(first.paths[model.path]), corrupt);
  assert.deepEqual(await readFile(repaired.paths[model.path]), bytes);
  assert.equal((await predecessor.readFile()).toString(), "{}");
  assert.equal((await readdir(container)).length, 2);
});

test("publication failure cleans only the unpublished generation", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-generation-publish-");
  await writeFile(join(root, model.path), corrupt);
  let selectionPath;
  await assert.rejects(
    resolveModelArtifacts(
      options(root, {
        dependencies: {
          async fetch() {
            const [container] = await entries(root, ".generations");
            selectionPath = container.replace(/\.generations$/u, ".current");
            // Simulate a filesystem conflict at publication, after the initial lookup.
            mkdirSync(selectionPath);
            return new Response(bytes);
          },
        },
      }),
    ),
    (error) => error.kind === "filesystem",
  );
  const [container] = await entries(root, ".generations");
  assert.deepEqual(await readdir(container), []);
  assert.deepEqual(await readFile(join(root, model.path)), corrupt);
  assert.ok((await stat(selectionPath)).isDirectory());
  assert.deepEqual(
    (await readdir(root)).filter(
      (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
    ),
    [],
  );
});

test("different manifests sharing a legacy path publish separate snapshots", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-generation-manifests-");
  await writeFile(join(root, model.path), corrupt);
  const otherBytes = Buffer.from("another verified model");
  const other = artifact(model.path, otherBytes);
  const results = await Promise.all(
    [model, other].map((entry) =>
      resolveModelArtifacts(
        options(root, {
          artifacts: [entry],
          dependencies: {
            async fetch() {
              return new Response(entry === model ? bytes : otherBytes);
            },
          },
        }),
      ),
    ),
  );
  assert.notEqual(results[0].directory, results[1].directory);
  assert.deepEqual(await readFile(results[0].paths[model.path]), bytes);
  assert.deepEqual(await readFile(results[1].paths[model.path]), otherBytes);
  assert.deepEqual(await readFile(join(root, model.path)), corrupt);
});

test("invalid selection records cannot redirect lookup outside a generation", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-generation-selection-");
  const first = await resolveModelArtifacts(
    options(root, {
      dependencies: {
        async fetch() {
          return new Response(bytes);
        },
      },
    }),
  );
  const { path, value } = await selected(root);
  await writeFile(join(root, model.path), bytes);
  const invalid = [
    "{",
    "null",
    "[]",
    JSON.stringify({ ...value, version: 99 }),
    JSON.stringify({ ...value, fingerprint: "wrong" }),
    ...["../outside", "/outside", "generation-missing"].map((generation) =>
      JSON.stringify({ ...value, generation }),
    ),
  ];
  for (const record of invalid) {
    await writeFile(path, record);
    const result = await resolveModelArtifacts(
      options(root, {
        dependencies: {
          async fetch() {
            assert.fail("valid legacy cache should remain readable");
          },
        },
      }),
    );
    assert.equal(result.directory, root);
  }
  assert.deepEqual(await readFile(first.paths[model.path]), bytes);
});

test(
  "a killed download leaves an unselected directory and the next caller recovers",
  { timeout: 15_000 },
  async (t) => {
    const root = await createTemporaryDirectory(t, "zvec-generation-killed-");
    const moduleUrl = new URL(
      "../../../dist/engine/models/artifact-downloader.js",
      import.meta.url,
    ).href;
    const script = `import { resolveModelArtifacts } from ${JSON.stringify(moduleUrl)};
    await resolveModelArtifacts({ ...${JSON.stringify(options(root))}, dependencies: { async fetch() {
      process.send('downloading'); return await new Promise(() => {});
    } } });`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    t.after(async () => {
      child.kill("SIGKILL");
      await exited;
    });
    await new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", () =>
        reject(new Error(`child exited before download: ${stderr}`)),
      );
    });
    const [container] = await entries(root, ".generations");
    assert.ok(container, "download must be isolated before network access");
    const abandoned = await readdir(container);
    assert.equal(abandoned.length, 1);
    assert.deepEqual(await entries(root, ".current"), []);
    child.kill("SIGKILL");
    await exited;
    const result = await resolveModelArtifacts(
      options(root, {
        dependencies: {
          async fetch() {
            return new Response(bytes);
          },
        },
      }),
    );
    assert.notEqual(basename(result.directory), abandoned[0]);
    assert.deepEqual(await readFile(result.paths[model.path]), bytes);
    assert.equal(
      (await readdir(container)).length,
      2,
      "do not delete another attempt's directory",
    );
    assert.equal(dirname(result.directory), container);
  },
);
