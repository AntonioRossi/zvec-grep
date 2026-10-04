import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZVecOpen } from "@zvec/zvec";
import { resolveWorkspaceIndexStoragePaths } from "../../dist/engine/storage/layout.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createZvecGrepMcpServer } from "../../dist/mcp/tools.js";
import { DaemonBackend } from "../../dist/daemon/backend.js";
import { createZvecGrep } from "../../dist/index.js";
import { CountingEmbeddingModel } from "../helpers/counting-embedding.mjs";
import { FakeEmbeddingModel } from "../helpers/fake-embedding.mjs";
import { buildLegacyHome } from "../helpers/legacy-index.mjs";
import { useIsolatedZvecGrepHome } from "../helpers/isolated-home.mjs";

useIsolatedZvecGrepHome();
const operations = ["migrate", "export", "import"];
const tool = (operation) => `zvec_grep_index_${operation}`;
const content = "# Beacon\n\nsealed kernel lantern phrase\n";

async function fixture(t, toolset = "full") {
  const parent = await mkdtemp(join(tmpdir(), "zg-mcp-portability-"));
  let client, server, backend;
  t.after(async () => {
    try {
      await client?.close();
      await server?.close();
    } finally {
      try {
        await backend?.close();
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    }
  });
  const model = new CountingEmbeddingModel();
  backend = new DaemonBackend({
    version: "test",
    modelPoolOptions: { createModel: () => model },
    createService: (options) =>
      createZvecGrep({ ...options, embeddingModel: model }),
    watchManagerFactory: () => ({
      start() {},
      flushPending: async () => {},
      close: async () => {},
    }),
  });
  server = createZvecGrepMcpServer(backend, "test", { toolset });
  client = new Client({ name: "portability-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(left), server.connect(right)]);
  return { parent, model, backend, client, server };
}

async function requireTool(client, operation) {
  const found = (await client.listTools()).tools.find(
    (item) => item.name === tool(operation),
  );
  assert.ok(found, `${tool(operation)} must be discovered through MCP`);
  return found;
}

async function call(client, operation, args, options) {
  const result = await client.callTool(
    { name: tool(operation), arguments: { confirm: true, ...args } },
    options,
  );
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent.state, "succeeded");
  return result.structuredContent.result;
}

async function source(parent) {
  const root = join(parent, "source");
  await documents(root);
  const service = await createZvecGrep({
    root,
    embeddingModel: new FakeEmbeddingModel(),
  });
  try {
    await service.index();
  } finally {
    await service.close();
  }
  const sourceHome = join(root, ".zvec-grep");
  const manifest = JSON.parse(
    await readFile(join(sourceHome, "manifest.json"), "utf8"),
  );
  return { root, sourceHome, id: manifest.id };
}
async function documents(root) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "beacon.md"), content);
  await writeFile(
    join(root, "stable.md"),
    "# Anchor\n\nquiet harbor anchor phrase\n",
  );
}
async function inventory(root) {
  const result = {};
  async function visit(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "locks") continue;
      const key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(join(dir, entry.name), `${key}/`);
      else
        result[key] = createHash("sha256")
          .update(await readFile(join(dir, entry.name)))
          .digest("hex");
    }
  }
  await visit(root);
  return result;
}
function vectors(home) {
  const collection = ZVecOpen(
    resolveWorkspaceIndexStoragePaths(home).indexPath,
    { readOnly: true },
  );
  try {
    return [...collection.iterDocsSync({ includeVector: true })]
      .map((doc) => ({ id: doc.id, vector: Array.from(doc.vectors.embedding) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } finally {
    collection.closeSync();
  }
}
async function searchAndReconcile(f, root, id) {
  const result = await f.client.callTool({
    name: "zvec_grep_search",
    arguments: { root, query: "sealed kernel lantern", autoUpdate: false },
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.match(JSON.stringify(result.content), /beacon.md/);
  assert.match(JSON.stringify(result.content), /sealed kernel lantern phrase/);
  const indexed = await f.client.callTool({
    name: "zvec_grep_index",
    arguments: { root, wait: true },
  });
  assert.equal(
    indexed.structuredContent.state,
    "succeeded",
    JSON.stringify(indexed),
  );
  await f.backend.close();
  assert.equal(
    f.model.counts.document,
    0,
    "unchanged documents must reuse vectors through close",
  );
  assert.ok(f.model.counts.query > 0, "the query model must run");
  assert.equal(
    JSON.parse(await readFile(join(root, ".zvec-grep/manifest.json"), "utf8"))
      .id,
    id,
  );
}

test("MCP portability discovery adds three full tools and preserves the default search toolset", async (t) => {
  const full = await fixture(t);
  for (const operation of operations) {
    const found = await requireTool(full.client, operation);
    assert.equal(found.annotations.readOnlyHint, false);
    assert.equal(found.annotations.destructiveHint, false);
  }
  const agent = await fixture(t, "agent");
  assert.deepEqual(
    (await agent.client.listTools()).tools.map((item) => item.name),
    ["zvec_grep_search"],
  );
});

test("MCP portability descriptions require a user request and server-visible paths", async (t) => {
  const f = await fixture(t);
  for (const operation of operations) {
    const found = await requireTool(f.client, operation);
    assert.match(found.description, /explicit user request/i);
    assert.match(found.description, /server/i);
    assert.match(found.description, /separate operation/i);
    assert.equal(found.inputSchema.properties.confirm.const, true);
  }
});

for (const operation of operations) {
  test(`MCP ${operation} rejects relative paths, missing confirmation and unknown fields`, async (t) => {
    const f = await fixture(t);
    await requireTool(f.client, operation);
    const paths =
      operation === "export"
        ? {
            sourceHome: join(f.parent, "source"),
            artifactPath: join(f.parent, "artifact"),
          }
        : operation === "migrate"
          ? {
              sourceHome: join(f.parent, "source"),
              destinationRoot: join(f.parent, "dest"),
            }
          : {
              artifactPath: join(f.parent, "artifact"),
              destinationRoot: join(f.parent, "dest"),
            };
    for (const args of [
      paths,
      { ...paths, confirm: false },
      { ...paths, confirm: true, extra: "ignored?" },
      { ...paths, confirm: true, [Object.keys(paths)[0]]: "relative" },
    ]) {
      const result = await f.client.callTool({
        name: tool(operation),
        arguments: args,
      });
      assert.equal(result.isError, true);
      assert.match(
        JSON.stringify(result.content),
        /valid|confirm|absolute|recognized/i,
      );
    }
    assert.deepEqual(
      await readdir(f.parent),
      [],
      "validation must precede all filesystem operations",
    );
  });
}

test("MCP migration preserves legacy workspace identity, content and all vectors", async (t) => {
  const f = await fixture(t);
  await requireTool(f.client, "migrate");
  const original = await source(f.parent);
  const legacy = join(original.root, ".zvec-grep-legacy");
  await buildLegacyHome(original.root, legacy, original.id);
  const before = await inventory(legacy);
  const destinationRoot = join(f.parent, "migrated");
  await documents(destinationRoot);
  const result = await call(f.client, "migrate", {
    sourceHome: legacy,
    destinationRoot,
  });
  assert.equal(result.indexId, original.id);
  assert.equal(result.filesConverted, 2);
  assert.equal(result.verification.vectorsExact, true);
  assert.equal(result.verification.vectorsSampled, false);
  assert.deepEqual(result.missingFiles, []);
  assert.deepEqual(await inventory(legacy), before);
  assert.deepEqual(
    vectors(join(destinationRoot, ".zvec-grep")),
    vectors(original.sourceHome),
  );
  await searchAndReconcile(f, destinationRoot, original.id);
});

test("MCP export preserves its source and sends ordered progress notifications", async (t) => {
  const f = await fixture(t);
  await requireTool(f.client, "export");
  const original = await source(f.parent);
  const before = await inventory(original.sourceHome);
  const artifactPath = join(f.parent, "artifact");
  const progress = [];
  const result = await call(
    f.client,
    "export",
    { sourceHome: original.sourceHome, artifactPath },
    { onprogress: (item) => progress.push(item) },
  );
  assert.equal(result.indexId, original.id);
  assert.equal(result.filesExported, 2);
  assert.deepEqual(await inventory(original.sourceHome), before);
  assert.ok(progress.length >= 3, "progress must be received through MCP");
  assert.match(progress.at(-1).message, /complete/i);
  for (let i = 1; i < progress.length; i++)
    assert.ok(progress[i].progress > progress[i - 1].progress);
  assert.equal(
    JSON.parse(await readFile(join(artifactPath, "format.json"), "utf8"))
      .indexId,
    original.id,
  );
});

test("MCP import preserves identity, expected content and zero document embeddings", async (t) => {
  const f = await fixture(t);
  await requireTool(f.client, "import");
  const original = await source(f.parent);
  const artifactPath = join(f.parent, "artifact");
  await call(f.client, "export", {
    sourceHome: original.sourceHome,
    artifactPath,
  });
  const before = await inventory(artifactPath);
  const destinationRoot = join(f.parent, "imported");
  await documents(destinationRoot);
  const result = await call(f.client, "import", {
    artifactPath,
    destinationRoot,
  });
  assert.equal(result.indexId, original.id);
  assert.equal(result.filesImported, 2);
  assert.equal(result.verification.vectorsExact, true);
  assert.equal(result.verification.vectorsSampled, false);
  assert.deepEqual(result.missingFiles, []);
  assert.deepEqual(await inventory(artifactPath), before);
  assert.deepEqual(
    vectors(join(destinationRoot, ".zvec-grep")),
    vectors(original.sourceHome),
  );
  await searchAndReconcile(f, destinationRoot, original.id);
});
