import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createZvecGrepMcpServer } from "../../dist/mcp/tools.js";
import { DaemonBackend } from "../../dist/daemon/backend.js";
import { createZvecGrep } from "../../dist/index.js";
import { exportWorkspaceIndex } from "../../dist/engine/transfer/index.js";
import { CountingEmbeddingModel } from "../helpers/counting-embedding.mjs";
import { buildLegacyHome } from "../helpers/legacy-index.mjs";
import { useIsolatedZvecGrepHome } from "../helpers/isolated-home.mjs";
useIsolatedZvecGrepHome();
let base, template;
after(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});
async function source() {
  return (template ??= (async () => {
    base = await mkdtemp(join(tmpdir(), "zg-mcp-summary-"));
    const root = join(base, "source");
    await mkdir(root);
    for (let i = 0; i < 25; i++)
      await writeFile(
        join(root, `document-${i}.md`),
        `# Item ${i}\nlantern orchard ${i}\n`,
      );
    const service = await createZvecGrep({
      root,
      embeddingModel: new CountingEmbeddingModel(),
    });
    let info;
    try {
      await service.index();
      info = await service.info();
    } finally {
      await service.close();
    }
    const legacy = join(base, "legacy"),
      artifact = join(base, "artifact");
    await buildLegacyHome(root, legacy, info.workspaceIndex.id);
    await exportWorkspaceIndex({
      sourceHome: join(root, ".zvec-grep"),
      artifactPath: artifact,
    });
    return { legacy, artifact, id: info.workspaceIndex.id };
  })());
}
for (const operation of ["migrate", "import"])
  for (const full of [false, true]) {
    test(`F6 MCP ${operation} ${full ? "explicit full list" : "bounded default list"} reports count and truncation in both outputs`, async (t) => {
      const s = await source();
      const destinationRoot = join(base, `${operation}-${full}`);
      await mkdir(destinationRoot);
      const backend = new DaemonBackend({ version: "test" });
      const server = createZvecGrepMcpServer(backend, "test", {
        toolset: "full",
      });
      const client = new Client({ name: "summary-control", version: "1" });
      t.after(async () => {
        try {
          await client.close();
          await server.close();
        } finally {
          await backend.close();
        }
      });
      const [left, right] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(left), server.connect(right)]);
      const input = {
        confirm: true,
        destinationRoot,
        ...(operation === "migrate"
          ? { sourceHome: s.legacy }
          : { artifactPath: s.artifact }),
        ...(full ? { includeAllMissingFiles: true } : {}),
      };
      const reply = await client.callTool({
        name: `zvec_grep_index_${operation}`,
        arguments: input,
      });
      assert.notEqual(reply.isError, true, JSON.stringify(reply));
      const result = reply.structuredContent.result;
      assert.equal(result.missingFilesCount, 25);
      assert.equal(result.missingFilesTruncated, !full);
      assert.equal(result.missingFiles.length, full ? 25 : 20);
      assert.equal(
        new Set(result.missingFiles).size,
        result.missingFiles.length,
      );
      assert.equal(result.indexId, s.id);
      assert.equal(result.verification.vectorsPreserved, true);
      const text = reply.content.find((x) => x.type === "text").text;
      assert.deepEqual(JSON.parse(text), reply.structuredContent);
      if (!full)
        assert.ok(text.length < 6000, `response too large: ${text.length}`);
    });
  }
