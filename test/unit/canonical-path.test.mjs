import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalFromRelative,
  canonicalRelativePath,
  createCanonicalPathResolver,
  findCanonicalNameCollisions,
  isCanonicalRelativePath,
  makeFileId,
  workspaceRootFingerprint,
} from "../../dist/engine/utils/canonical-path.js";

// NFC form: U+00E9 (e-acute). NFD form: U+0065 U+0301 (e + combining acute).
const NFC_E = "\u00e9";
const NFD_E = "e\u0301";

test("canonicalFromRelative normalizes separators, dots and Unicode", () => {
  assert.equal(canonicalFromRelative("a/b/c.md"), "a/b/c.md");
  assert.equal(canonicalFromRelative("./a//b/"), "a/b");
  assert.equal(
    canonicalFromRelative(`a/caf${NFD_E}.md`),
    `a/caf${NFC_E}.md`,
  );
});

test("canonicalRelativePath rejects paths outside the workspace", () => {
  const root = join(tmpdir(), "crp-root");
  assert.equal(
    canonicalRelativePath(root, join(root, "views", "one.md")),
    "views/one.md",
  );
  assert.equal(canonicalRelativePath(root, root), null);
  assert.equal(canonicalRelativePath(root, join(root, "..", "other.md")), null);
  assert.equal(canonicalRelativePath(root, "/elsewhere/one.md"), null);
});

test("isCanonicalRelativePath validates form", () => {
  assert.equal(isCanonicalRelativePath("."), true);
  assert.equal(isCanonicalRelativePath("a/b.md"), true);
  assert.equal(isCanonicalRelativePath(""), false);
  assert.equal(isCanonicalRelativePath("/a"), false);
  assert.equal(isCanonicalRelativePath("a/"), false);
  assert.equal(isCanonicalRelativePath("a/../b"), false);
  assert.equal(isCanonicalRelativePath("a//b"), false);
});

test("makeFileId depends on the CRP, not the host location", () => {
  const idA = makeFileId("uuid-1", "views/one.md");
  const idB = makeFileId("uuid-1", "views/one.md");
  const idC = makeFileId("uuid-2", "views/one.md");
  const idD = makeFileId("uuid-1", "views/other.md");
  assert.equal(idA, idB);
  assert.notEqual(idA, idC);
  assert.notEqual(idA, idD);
});

test("resolver maps NFD storage through NFC canonical spelling", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "crp-resolve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs"));
  const nfdName = `caf${NFD_E}.md`;
  await writeFile(join(root, "docs", nfdName), "content");
  const resolver = createCanonicalPathResolver(root);
  const crp = canonicalFromRelative(`docs/${nfdName}`);
  assert.equal(crp, `docs/caf${NFC_E}.md`);
  assert.equal(resolver.resolveSync(crp), join(root, "docs", nfdName));
  assert.equal(await resolver.resolve(crp), join(root, "docs", nfdName));
});

test("resolver returns null for missing files and resolves the root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "crp-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resolver = createCanonicalPathResolver(root);
  assert.equal(resolver.resolveSync("docs/absent.md"), null);
  assert.equal(resolver.resolveSync("."), root);
});

test("resolver rejects ambiguous NFC collisions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "crp-collide-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", `caf${NFC_E}.md`), "nfc");
  await writeFile(join(root, "docs", `caf${NFD_E}.md`), "nfd");
  const resolver = createCanonicalPathResolver(root);
  assert.throws(
    () => resolver.resolveSync(`docs/caf${NFC_E}.md`),
    /ambiguous/,
  );
});

test("findCanonicalNameCollisions detects Unicode and case groups", () => {
  const collisions = findCanonicalNameCollisions("/x", [
    `caf${NFC_E}.md`,
    `caf${NFD_E}.md`,
    "README.md",
    "readme.md",
    "other.txt",
  ]);
  const unicode = collisions.find((c) => c.kind === "unicode");
  const caseCollision = collisions.find(
    (c) => c.kind === "case" && c.names.includes("README.md"),
  );
  assert.deepEqual(unicode?.names.sort(), [
    `caf${NFD_E}.md`,
    `caf${NFC_E}.md`,
  ]);
  assert.deepEqual(caseCollision?.names.sort(), ["README.md", "readme.md"]);
});

test("workspaceRootFingerprint is stable for the same root", () => {
  assert.equal(
    workspaceRootFingerprint("/tmp"),
    workspaceRootFingerprint("/tmp"),
  );
  assert.notEqual(
    workspaceRootFingerprint("/tmp"),
    workspaceRootFingerprint("/var"),
  );
});

test("resolver toCanonical round-trips within the workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "crp-roundtrip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "a"), { recursive: true });
  await writeFile(join(root, "a", "b.md"), "x");
  const resolver = createCanonicalPathResolver(root);
  const crp = resolver.toCanonical(join(root, "a", "b.md"));
  assert.equal(crp, "a/b.md");
  assert.equal(resolver.resolveSync(crp), join(root, "a", "b.md"));
  assert.equal(resolver.toCanonical(join(root, "..", "outside.md")), null);
});

test("symlink entries resolve through their link path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "crp-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "real"));
  await writeFile(join(root, "real", "f.md"), "x");
  await symlink(join(root, "real"), join(root, "link"));
  const resolver = createCanonicalPathResolver(root);
  assert.equal(resolver.resolveSync("link/f.md"), join(root, "link", "f.md"));
});
