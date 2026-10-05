import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { createZvecGrep } from "../../dist/index.js";
import { DaemonBackend } from "../../dist/daemon/backend.js";
import { DaemonError } from "../../dist/daemon/errors.js";
import { DaemonHttpServer } from "../../dist/daemon/http-server.js";
import { CountingEmbeddingModel } from "../helpers/counting-embedding.mjs";
import { useIsolatedZvecGrepHome } from "../helpers/isolated-home.mjs";
useIsolatedZvecGrepHome();
const exec = promisify(execFile);
const cli = resolve("dist/cli/index.js");
function model() {
  const model = new CountingEmbeddingModel();
  model.info = {
    ...model.info,
    reference: "local/potion-code-16m-v2",
    provider: "local",
    name: "potion-code-16m-v2",
  };
  return model;
}
async function fixture(t, state = "indexed", failure) {
  const base = await mkdtemp(join(tmpdir(), "zg-search-preflight-"));
  let service, backend, server;
  t.after(async () => {
    await server?.close();
    await backend?.close();
    await service?.close();
    await rm(base, { recursive: true, force: true });
  });
  const root = join(base, "workspace"),
    home = join(base, "home");
  await mkdir(root);
  await mkdir(home);
  const file = join(root, "answer.md");
  await writeFile(file, "# Answer\nsealed orchard phrase\n");
  service = await createZvecGrep({ root, embeddingModel: model() });
  if (state === "indexed") await service.index();
  if (state === "disabled") await service.disableIndex();
  await service.close();
  service = undefined;
  backend = new DaemonBackend({
    version: "test",
    modelPoolOptions: { createModel: model },
    watchManagerFactory: () => ({
      start() {},
      flushPending: async () => {},
      close: async () => {},
    }),
  });
  const calls = [];
  for (const name of ["search", "indexStatus", "index"]) {
    const original = backend[name].bind(backend);
    backend[name] = async (...args) => {
      calls.push({ name, input: args[0] });
      if (name === "search" && failure)
        throw new DaemonError(failure, "test authorization refusal");
      return original(...args);
    };
  }
  server = new DaemonHttpServer({
    host: "127.0.0.1",
    port: 0,
    version: "test",
    backend,
  });
  const address = await server.start();
  const run = async (args = []) => {
    try {
      return {
        code: 0,
        ...(await exec(
          process.execPath,
          [
            cli,
            "orchard",
            "--mode",
            "server",
            "--home",
            home,
            "--color",
            "never",
            ...args,
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              ZVEC_GREP_SERVER_URL: `http://127.0.0.1:${address.port}/mcp`,
              ZVEC_GREP_HOME: home,
              ZVEC_GREP_SERVER_TOKEN: "",
              ZVEC_GREP_SERVER_TOKEN_FILE: "",
            },
            timeout: 20000,
          },
        )),
      };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  return { calls, run, file };
}

test("F4 an existing index is searched through the real CLI and MCP without a status preflight", async (t) => {
  const f = await fixture(t);
  for (const [refresh, freshness, autoUpdate] of [
    ["off", "eventual", false],
    ["background", "eventual", true],
    ["wait", "wait_for_fresh", true],
  ]) {
    const result = await f.run(["--refresh", refresh]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /orchard/);
    assert.deepEqual(
      f.calls.map((x) => x.name),
      ["search"],
    );
    assert.equal(f.calls[0].input.freshness, freshness);
    assert.equal(f.calls[0].input.autoUpdate, autoUpdate);
    f.calls.length = 0;
  }
});

test("F4 a missing index is created only after search reports it missing and then the search is retried", async (t) => {
  const f = await fixture(t, "missing");
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /orchard/);
  assert.deepEqual(
    f.calls.map((x) => x.name),
    ["search", "indexStatus", "index", "search"],
  );
  assert.match(result.stderr, /No index found/);
});

test("F4 a disabled index is not created after the search-first policy check", async (t) => {
  const f = await fixture(t, "disabled");
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /INDEX_MISSING/);
  assert.deepEqual(
    f.calls.map((x) => x.name),
    ["search", "indexStatus"],
  );
  assert.doesNotMatch(result.stderr, /No index found/);
});

test("F4 an authorization failure is returned without a status scan or index creation", async (t) => {
  const f = await fixture(t, "indexed", "REMOTE_EMBEDDING_AUTH_REQUIRED");
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /REMOTE_EMBEDDING_AUTH_REQUIRED/);
  assert.deepEqual(
    f.calls.map((x) => x.name),
    ["search"],
  );
});
