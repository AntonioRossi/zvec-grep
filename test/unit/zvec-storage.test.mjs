import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ZVecCollectionSchema,
  ZVecCreateAndOpen,
  ZVecDataType,
} from "@zvec/zvec";
import { createWorkspaceIndexStorage } from "../../dist/engine/storage/index.js";
import {
  parseRange,
  queryFileMetadataDocs,
} from "../../dist/engine/storage/zvec.js";

function doc(id) {
  return {
    id,
    fields: { file_id: id },
    vectors: {},
    score: 0,
  };
}

test("file metadata queries partition beyond zvec's top-k limit", () => {
  const documents = [
    doc(`${"0".repeat(64)}`),
    doc(`0${"f".repeat(63)}`),
    doc(`1${"0".repeat(63)}`),
    doc(`a${"5".repeat(63)}`),
    doc(`f${"f".repeat(63)}`),
    doc(`b${"0".repeat(63)}`),
  ];
  const queries = [];
  const collection = {
    stats: { docCount: documents.length, indexCompleteness: {} },
    querySync(query) {
      queries.push(query);
      const lower = /file_id >= '([^']+)'/.exec(query.filter)?.[1];
      const upper = /file_id < '([^']+)'/.exec(query.filter)?.[1];
      return documents
        .filter((item) => lower === undefined || item.id >= lower)
        .filter((item) => upper === undefined || item.id < upper)
        .slice(0, query.topk);
    },
  };

  const result = queryFileMetadataDocs(collection, 2);

  assert.deepEqual(
    result.map((item) => item.id).sort(),
    documents.map((item) => item.id).sort(),
  );
  assert.ok(queries.length > 16);
  assert.ok(queries.every((query) => query.topk <= 2));
});

test("file metadata queries use one request below zvec's top-k limit", () => {
  const queries = [];
  const collection = {
    stats: { docCount: 2, indexCompleteness: {} },
    querySync(query) {
      queries.push(query);
      return [doc(`0${"0".repeat(63)}`), doc(`f${"f".repeat(63)}`)];
    },
  };

  const result = queryFileMetadataDocs(collection, 2);

  assert.equal(result.length, 2);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].topk, 2);
});

test("file metadata partitions use zvec string range semantics", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "zvec-grep-file-meta-range-"));
  const collection = ZVecCreateAndOpen(
    join(parent, "collection"),
    new ZVecCollectionSchema({
      name: "file_metadata_range",
      fields: [{ name: "file_id", dataType: ZVecDataType.STRING }],
    }),
  );
  t.after(async () => {
    collection.closeSync();
    await rm(parent, { recursive: true, force: true });
  });

  const documents = [
    doc(`${"0".repeat(64)}`),
    doc(`0${"f".repeat(63)}`),
    doc(`1${"0".repeat(63)}`),
    doc(`a${"5".repeat(63)}`),
    doc(`f${"f".repeat(63)}`),
    doc(`b${"0".repeat(63)}`),
  ];
  collection.insertSync(
    documents.map((item) => ({ id: item.id, fields: item.fields })),
  );

  const result = queryFileMetadataDocs(collection, 2);

  assert.deepEqual(
    result.map((item) => item.id).sort(),
    documents.map((item) => item.id).sort(),
  );
});

test("file metadata supports one batched path-prefix lookup", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "zvec-grep-file-prefixes-"));
  const root = join(parent, "repo");
  const storage = createWorkspaceIndexStorage({
    storagePath: join(parent, "storage"),
    workspaceRoot: root,
    readOnly: false,
    embedding: {
      provider: "local",
      model: "test",
      dimension: 2,
      metric: "cosine",
    },
  });
  t.after(async () => {
    storage.close();
    await rm(parent, { recursive: true, force: true });
  });
  const files = [
    fileInfo("a", root, "src/a.ts"),
    fileInfo("b", root, "src/nested/b.ts"),
    fileInfo("c", root, "docs/c.md"),
  ];
  for (const file of files) storage.replaceFile(file, []);

  const matches = storage.listFilesByPathPrefixes([
    join(root, "src"),
    join(root, "docs", "c.md"),
  ]);

  assert.deepEqual(matches.map((file) => file.relativePath).sort(), [
    "docs/c.md",
    "src/a.ts",
    "src/nested/b.ts",
  ]);
});

test("parseRange accepts every supported well-formed range", () => {
  assert.deepEqual(parseRange('{"kind":"file"}'), { kind: "file" });
  assert.deepEqual(
    parseRange(
      '{"kind":"text","startLine":1,"endLine":3,"startOffset":0,"endOffset":42}',
    ),
    { kind: "text", startLine: 1, endLine: 3, startOffset: 0, endOffset: 42 },
  );
  assert.deepEqual(
    parseRange('{"kind":"byte","startOffset":0,"endOffset":10}'),
    {
      kind: "byte",
      startOffset: 0,
      endOffset: 10,
    },
  );
  assert.deepEqual(parseRange('{"kind":"page","page":2}'), {
    kind: "page",
    page: 2,
  });
  assert.deepEqual(
    parseRange('{"kind":"page_text","page":1,"startOffset":0,"endOffset":5}'),
    { kind: "page_text", page: 1, startOffset: 0, endOffset: 5 },
  );
  assert.deepEqual(
    parseRange(
      '{"kind":"page_region","page":0,"x":0.5,"y":1,"width":2.5,"height":3}',
    ),
    { kind: "page_region", page: 0, x: 0.5, y: 1, width: 2.5, height: 3 },
  );
});

test("parseRange rejects non-object serialized ranges", () => {
  for (const value of ["null", "42", '"text"', "true", '[{"kind":"file"}]']) {
    assertInvalidRange(value);
  }
  assert.throws(() => parseRange("{not json"), "malformed JSON must not parse");
});

test("parseRange rejects unknown kinds and invalid fields", () => {
  assertInvalidRange('{"kind":"wat"}');
  assertInvalidRange('{"kind":"text","startLine":1}');
  assertInvalidRange(
    '{"kind":"text","startLine":-1,"endLine":1,"startOffset":0,"endOffset":1}',
  );
  assertInvalidRange(
    '{"kind":"text","startLine":1.5,"endLine":2,"startOffset":0,"endOffset":1}',
  );
  assertInvalidRange('{"kind":"page","page":"2"}');
  assertInvalidRange(
    '{"kind":"page_region","page":0,"x":-1,"y":0,"width":1,"height":1}',
  );
  assertInvalidRange(
    '{"kind":"page_region","page":0,"x":1e999,"y":0,"width":1,"height":1}',
  );
});

test("parseRange rejects inverted ranges", () => {
  assertInvalidRange(
    '{"kind":"text","startLine":3,"endLine":1,"startOffset":0,"endOffset":1}',
  );
  assertInvalidRange('{"kind":"byte","startOffset":10,"endOffset":5}');
  assertInvalidRange(
    '{"kind":"page_text","page":1,"startOffset":5,"endOffset":0}',
  );
});

function assertInvalidRange(value) {
  assert.throws(
    () => parseRange(value),
    (error) => error?.code === "ZVEC_GREP.ENGINE.STORAGE.INVALID_RANGE",
    `range must be rejected with INVALID_RANGE: ${value}`,
  );
}

function fileInfo(id, root, relativePath) {
  return {
    id: id.repeat(64),
    absolutePath: join(root, relativePath),
    canonicalPath: relativePath,
    relativePath,
    rootPath: root,
    sizeBytes: 1,
    lastModifiedTime: 1,
    kind: relativePath.endsWith(".md") ? "markdown" : "code",
    format: relativePath.endsWith(".md") ? "markdown" : "typescript",
  };
}
