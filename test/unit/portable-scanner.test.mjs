import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanRootPaths } from "../../dist/engine/pipeline/indexing/scanner/index.js";
import { makeFileId } from "../../dist/engine/utils/canonical-path.js";

const NFC_E = "é";
const NFD_E = "é";

async function makeWorkspace(t, prefix = "zg-scan-portable-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("scanned file identity is root-independent within the workspace", async (t) => {
  const root = await makeWorkspace(t);
  await mkdir(join(root, "views", "decisions"), { recursive: true });
  await writeFile(join(root, "views", "decisions", "one.md"), "# One\n");

  const fromWorkspace = await scanRootPaths(
    "index-id",
    [{ absolutePath: root, recursive: true }],
    { workspaceRoot: root },
  );
  const fromSubroot = await scanRootPaths(
    "index-id",
    [{ absolutePath: join(root, "views"), recursive: true }],
    { workspaceRoot: root },
  );

  const idFromWorkspace = fromWorkspace.files.find((file) =>
    file.relativePath.endsWith("one.md"),
  )?.id;
  const idFromSubroot = fromSubroot.files.find((file) =>
    file.relativePath.endsWith("one.md"),
  )?.id;
  assert.ok(idFromWorkspace);
  assert.equal(idFromSubroot, idFromWorkspace);
  assert.equal(
    idFromWorkspace,
    makeFileId("index-id", "views/decisions/one.md"),
  );

  // Legacy mode (no workspaceRoot) keeps absolute-path identities.
  const legacy = await scanRootPaths(
    "index-id",
    [{ absolutePath: root, recursive: true }],
    {},
  );
  assert.notEqual(
    legacy.files.find((file) => file.relativePath.endsWith("one.md"))?.id,
    idFromWorkspace,
  );
});

test("scanner rejects canonical name collisions", async (t) => {
  const root = await makeWorkspace(t);
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", `caf${NFC_E}.md`), "nfc");
  await writeFile(join(root, "docs", `caf${NFD_E}.md`), "nfd");

  await assert.rejects(
    () =>
      scanRootPaths("index-id", [{ absolutePath: root, recursive: true }], {
        workspaceRoot: root,
      }),
    (error) =>
      error.code === "ZVEC_GREP.ENGINE.SCANNER.CANONICAL_NAME_COLLISION",
  );
});

test("followed symlinks escaping the workspace are excluded with diagnostics", async (t) => {
  const root = await makeWorkspace(t);
  const outside = await makeWorkspace(t, "zg-scan-outside-");
  await writeFile(join(outside, "secret.md"), "outside");
  await symlink(join(outside, "secret.md"), join(root, "link.md"));

  const result = await scanRootPaths(
    "index-id",
    [{ absolutePath: root, recursive: true, follow: true }],
    { workspaceRoot: root },
  );
  assert.equal(result.files.length, 0);
  assert.equal(result.diagnostics.skippedByReason.escapes_workspace, 1);

  // Without follow the symlink is simply not a file and nothing is reported.
  const noFollow = await scanRootPaths(
    "index-id",
    [{ absolutePath: root, recursive: true }],
    { workspaceRoot: root },
  );
  assert.equal(noFollow.files.length, 0);
  assert.equal(noFollow.diagnostics.skippedByReason.escapes_workspace, 0);
});

test("NFD filenames receive NFC canonical identities and resolve for reading", async (t) => {
  const root = await makeWorkspace(t);
  await mkdir(join(root, "docs"));
  const nfdName = `caf${NFD_E}.md`;
  await writeFile(join(root, "docs", nfdName), "content");

  const result = await scanRootPaths(
    "index-id",
    [{ absolutePath: root, recursive: true }],
    { workspaceRoot: root },
  );
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].canonicalPath, `docs/caf${NFC_E}.md`);
  assert.equal(
    result.files[0].id,
    makeFileId("index-id", `docs/caf${NFC_E}.md`),
  );
});
