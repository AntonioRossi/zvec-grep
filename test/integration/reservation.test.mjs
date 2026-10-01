import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ZVecInitialize, ZVecLogLevel } from "@zvec/zvec";
import { migrateWorkspaceIndex } from "../../dist/engine/migrate/index.js";
import { reserveDestination } from "../../dist/engine/reservation.js";
import {
  exportWorkspaceIndex,
  importWorkspaceIndex,
} from "../../dist/engine/transfer/index.js";
import { readWorkspaceManifest } from "../../dist/engine/manifest.js";
import { assertNoWriteLock } from "../../dist/engine/utils/lock.js";
import { createZvecGrep } from "../../dist/index.js";
import { createTemporaryDirectory } from "../helpers/fixtures.mjs";
import { FakeEmbeddingModel } from "../helpers/fake-embedding.mjs";
import { useIsolatedZvecGrepHome } from "../helpers/isolated-home.mjs";
import { buildLegacyHome } from "../helpers/legacy-index.mjs";

useIsolatedZvecGrepHome();

const FIXTURES = {
  "docs/guide.md": "# Guide\n\nReservation protocol fixture content.\n",
};

async function makeLegacySource(t, parent) {
  const sourceRoot = join(parent, "original");
  await mkdir(join(sourceRoot, "docs"), { recursive: true });
  await writeFile(
    join(sourceRoot, "docs", "guide.md"),
    FIXTURES["docs/guide.md"],
  );
  const service = await createZvecGrep({
    root: sourceRoot,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await service.index();
  await service.close();
  const manifest = readWorkspaceManifest(join(sourceRoot, ".zvec-grep"));
  const legacyHome = join(sourceRoot, ".zvec-grep-legacy");
  await buildLegacyHome(sourceRoot, legacyHome, manifest.id);
  return { sourceRoot, legacyHome };
}

test("reservation blocks competing writers and discovery during migration", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-reserve-block-");
  const { legacyHome } = await makeLegacySource(t, parent);
  const destinationRoot = join(parent, "destination");
  await mkdir(join(destinationRoot, "docs"), { recursive: true });
  await writeFile(
    join(destinationRoot, "docs", "guide.md"),
    FIXTURES["docs/guide.md"],
  );

  const competitorEvidence = [];
  const result = await migrateWorkspaceIndex({
    sourceHome: legacyHome,
    destinationRoot,
    onProgress: (stage) => {
      if (stage === "write") {
        // A competing writer and a discovery-time guard both meet the
        // reservation while it is held.
        try {
          assertNoWriteLock(
            join(destinationRoot, ".zvec-grep", "locks", "home"),
            "competitor",
          );
          competitorEvidence.push("not-blocked");
        } catch (error) {
          competitorEvidence.push(error.code);
        }
      }
    },
  });
  assert.equal(result.verification.countsMatch, true);
  assert.deepEqual(competitorEvidence, ["ZVEC_GREP.ENGINE.LOCK.BUSY"]);

  // After commit the destination is a normal, usable index.
  const manifest = readWorkspaceManifest(join(destinationRoot, ".zvec-grep"));
  assert.ok(manifest?.embedding);
});

test("a replaced reservation aborts without merging or deleting foreign content", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-reserve-replace-");
  const { legacyHome } = await makeLegacySource(t, parent);
  const destinationRoot = join(parent, "destination");
  await mkdir(join(destinationRoot, "docs"), { recursive: true });
  await writeFile(
    join(destinationRoot, "docs", "guide.md"),
    FIXTURES["docs/guide.md"],
  );
  const destinationHome = join(destinationRoot, ".zvec-grep");

  await assert.rejects(
    migrateWorkspaceIndex({
      sourceHome: legacyHome,
      destinationRoot,
      onProgress: (stage) => {
        if (stage === "verify") {
          // Deliberate replacement of the reserved destination before
          // publication, synchronously so the publish step sees it. Churn
          // keeps the replacement's inode distinct; a same-inode replacement
          // is physically indistinguishable by construction.
          rmSync(destinationHome, { recursive: true, force: true });
          for (let i = 0; i < 64; i++) {
            mkdirSync(join(destinationRoot, `churn-${i}`));
          }
          mkdirSync(destinationHome, { recursive: true });
          writeFileSync(join(destinationHome, "sentinel.txt"), "foreign claim");
        }
      },
    }),
    /replaced before publication|RESERVATION|not exist/,
    "the operation must fail loudly when its reservation is replaced",
  );

  const entries = await readdir(destinationHome);
  assert.deepEqual(entries, ["sentinel.txt"]);
  assert.equal(
    await readFile(join(destinationHome, "sentinel.txt"), "utf8"),
    "foreign claim",
    "the replacement must be preserved exactly",
  );
});

test("an error after commit never touches the published result", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-reserve-commit-");
  const { legacyHome } = await makeLegacySource(t, parent);
  const destinationRoot = join(parent, "destination");
  await mkdir(join(destinationRoot, "docs"), { recursive: true });
  await writeFile(
    join(destinationRoot, "docs", "guide.md"),
    FIXTURES["docs/guide.md"],
  );

  await assert.rejects(
    migrateWorkspaceIndex({
      sourceHome: legacyHome,
      destinationRoot,
      onProgress: (stage) => {
        if (stage === "done") {
          throw new Error("injected post-commit failure");
        }
      },
    }),
    /injected post-commit failure/,
  );

  // The published destination survives with its complete content.
  const manifest = readWorkspaceManifest(join(destinationRoot, ".zvec-grep"));
  assert.ok(manifest?.embedding);
  const entries = await readdir(join(destinationRoot, ".zvec-grep"));
  assert.ok(entries.includes("files.zvec"));
  assert.ok(entries.includes("index.zvec"));
});

test("an incomplete destination stays blocked after lock cleanup, with no ancestor fallback", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-reserve-incomplete-");
  const { legacyHome } = await makeLegacySource(t, parent);
  const destinationRoot = join(parent, "destination");
  await mkdir(join(destinationRoot, "docs"), { recursive: true });
  await writeFile(
    join(destinationRoot, "docs", "guide.md"),
    FIXTURES["docs/guide.md"],
  );
  const destinationHome = join(destinationRoot, ".zvec-grep");

  // Simulate a crashed operation: the durable marker and a dead owner's
  // write lock persist; partial staged content is present.
  const lockDir = join(destinationHome, "locks", "home.write");
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, "lock.json"),
    `${JSON.stringify(
      {
        token: "crashed-token",
        pid: 99_999_999,
        hostname: (await import("node:os")).hostname(),
        startedAt: Date.now(),
        operation: "index.import",
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(join(destinationHome, "staging-crashed"), { recursive: true });
  await writeFile(
    join(destinationHome, "INCOMPLETE"),
    `${JSON.stringify({ token: "crashed-token", operation: "index.import" })}\n`,
  );

  const service = await createZvecGrep({
    root: destinationRoot,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await assert.rejects(
    service.context({ query: "guide", limit: 3 }),
    /incomplete|INCOMPLETE|Index unavailable/i,
    "readers are blocked while the abandoned reservation's lock persists",
  );
  await service.close();

  // The operator removes the lock directory during recovery; the marker
  // alone still blocks readers and writers (no ancestor fallback).
  await rm(join(destinationHome, "locks"), { recursive: true, force: true });
  const service2 = await createZvecGrep({
    root: destinationRoot,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await assert.rejects(
    service2.context({ query: "guide", limit: 3 }),
    /incomplete|INCOMPLETE/i,
    "the durable marker alone keeps the destination blocked",
  );
  await assert.rejects(
    service2.index(),
    /incomplete|INCOMPLETE|busy|BUSY/i,
    "writers are blocked by the durable marker",
  );
  await service2.close();

  // Documented recovery: with writers quiescent, remove the marker and the
  // partial contents; the workspace is usable again.
  await rm(destinationHome, { recursive: true, force: true });
  const result = await migrateWorkspaceIndex({
    sourceHome: legacyHome,
    destinationRoot,
  });
  assert.equal(result.verification.countsMatch, true);
});

test("a crashed destination stays blocked even with an ancestor index present", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-reserve-ancestor-");

  // The parent workspace has a working index (the ancestor fallback).
  await mkdir(join(parent, "docs"), { recursive: true });
  await writeFile(
    join(parent, "docs", "ancestor.md"),
    "# Ancestor\n\nAncestor content.\n",
  );
  const parentService = await createZvecGrep({
    root: parent,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await parentService.index();
  await parentService.close();

  // The child workspace has an incomplete reserved destination.
  const child = join(parent, "child");
  const childHome = join(child, ".zvec-grep");
  await mkdir(childHome, { recursive: true });
  await writeFile(join(child, "docs.md"), "# Child\n\nChild content.\n");
  await writeFile(
    join(childHome, "INCOMPLETE"),
    `${JSON.stringify({ token: "crashed", operation: "index.import" })}\n`,
  );

  // Discovery from inside the child must not fall back to the parent's index.
  const service = await createZvecGrep({
    root: child,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await assert.rejects(
    service.context({ query: "ancestor content", limit: 3 }),
    /incomplete|INCOMPLETE/i,
    "the incomplete child must block instead of falling back to the ancestor",
  );
  await service.close();

  // The parent's own index still works normally.
  const parentSearch = await createZvecGrep({
    root: parent,
    embeddingModel: new FakeEmbeddingModel(),
  });
  const result = await parentSearch.context({
    query: "ancestor content",
    limit: 3,
  });
  assert.ok(result.items.length > 0);
  await parentSearch.close();
});

test("ownership loss during finalization publishes nothing", async (t) => {
  const parent = await createTemporaryDirectory(t, "zg-reserve-finalize-");
  const destinationHome = join(parent, "destination", ".zvec-grep");
  await mkdir(join(parent, "destination"), { recursive: true });
  const reservation = reserveDestination({
    destinationHome,
    operation: "test.finalize-loss",
    existingIndexMarkers: ["manifest.json"],
  });
  await writeFile(join(reservation.stagingHome, "payload.txt"), "staged");
  const lockDir = join(destinationHome, "locks", "home.write");

  await assert.rejects(
    Promise.resolve().then(() =>
      reservation.publish(() => {
        // Ownership is lost while finalization runs.
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir, { recursive: true });
        writeFileSync(
          join(lockDir, "lock.json"),
          `${JSON.stringify({ token: "competitor" })}\n`,
        );
      }),
    ),
    /ownership.*lost|RESERVATION/i,
  );
  const destinationEntries = await readdir(destinationHome);
  assert.ok(!destinationEntries.includes("manifest.json"));
  assert.ok(
    !destinationEntries.includes("payload.txt"),
    "nothing was published into the compromised destination",
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(lockDir, "lock.json"), "utf8")).token,
    "competitor",
    "the replacement lock survives the fenced publication",
  );
});

test("an aborted staging replacement preserves the foreign file", async (t) => {
  const parent = await createTemporaryDirectory(t, "zg-reserve-staging-");
  const destinationHome = join(parent, "destination", ".zvec-grep");
  await mkdir(join(parent, "destination"), { recursive: true });
  const reservation = reserveDestination({
    destinationHome,
    operation: "test.staging-replace",
    existingIndexMarkers: ["manifest.json"],
  });

  // Replace only the staging directory with foreign content.
  rmSync(reservation.stagingHome, { recursive: true, force: true });
  for (let i = 0; i < 64; i++) {
    mkdirSync(join(parent, `churn-${i}`));
  }
  mkdirSync(reservation.stagingHome, { recursive: true });
  writeFileSync(join(reservation.stagingHome, "foreign.txt"), "not ours");

  const cleanup = reservation.abort();
  assert.equal(
    await readFile(join(reservation.stagingHome, "foreign.txt"), "utf8"),
    "not ours",
    "abort must not delete a staging replacement",
  );
  // Skipped cleanup is unfinished cleanup: the foreign content is preserved,
  // the marker is preserved as blockage, and the state is reported.
  assert.match(cleanup, /replaced by foreign content/i);
  assert.match(cleanup, /blocked by the INCOMPLETE marker/i);
  assert.ok(existsSync(join(destinationHome, "INCOMPLETE")));
  assert.throws(() => readWorkspaceManifest(destinationHome), /incomplete/i);
});

test("an abandoned reservation stays blocked until the documented operator recovery", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-reserve-abandon-");
  const { legacyHome } = await makeLegacySource(t, parent);
  const destinationRoot = join(parent, "destination");
  await mkdir(join(destinationRoot, "docs"), { recursive: true });
  await writeFile(
    join(destinationRoot, "docs", "guide.md"),
    FIXTURES["docs/guide.md"],
  );

  // Simulate an abandoned reservation: a write lock whose owner is dead.
  // Automatic reclamation is intentionally removed, so this stays blocked.
  const lockDir = join(destinationRoot, ".zvec-grep", "locks", "home.write");
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, "lock.json"),
    `${JSON.stringify(
      {
        token: "abandoned-token",
        pid: 99_999_999,
        hostname: (await import("node:os")).hostname(),
        startedAt: Date.now(),
        operation: "index.migrate",
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    migrateWorkspaceIndex({
      sourceHome: legacyHome,
      destinationRoot,
    }),
    (error) => error.code === "ZVEC_GREP.ENGINE.LOCK.BUSY",
    "an abandoned write lock blocks until operator recovery",
  );

  // Documented recovery: with writers quiescent, the operator removes the
  // lock directory; the operation then proceeds.
  await rm(join(destinationRoot, ".zvec-grep", "locks"), {
    recursive: true,
    force: true,
  });
  const result = await migrateWorkspaceIndex({
    sourceHome: legacyHome,
    destinationRoot,
  });
  assert.equal(result.verification.countsMatch, true);
});

test("export rejects a destination with unrelated contents without touching them", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-reserve-export-");
  const sourceRoot = join(parent, "original");
  await mkdir(join(sourceRoot, "docs"), { recursive: true });
  await writeFile(
    join(sourceRoot, "docs", "guide.md"),
    FIXTURES["docs/guide.md"],
  );
  const service = await createZvecGrep({
    root: sourceRoot,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await service.index();
  await service.close();

  // A competitor already claimed the artifact path with its own content:
  // export must reject the destination and preserve the foreign files.
  const claimedArtifact = join(parent, "claimed-artifact");
  await mkdir(claimedArtifact, { recursive: true });
  await writeFile(join(claimedArtifact, "owner.txt"), "competitor");
  await assert.rejects(
    exportWorkspaceIndex({
      sourceHome: join(sourceRoot, ".zvec-grep"),
      artifactPath: claimedArtifact,
    }),
    /unrelated contents/,
  );
  assert.equal(
    await readFile(join(claimedArtifact, "owner.txt"), "utf8"),
    "competitor",
  );
  assert.ok(
    !(await readdir(claimedArtifact)).includes("entities.jsonl"),
    "no export content is written beside the foreign claim",
  );

  // A foreign colliding child inside the reserved destination is rejected
  // at publication and never overwritten (direct protocol exercise).
  const collisionHome = join(parent, "collision-home");
  const reservation = reserveDestination({
    destinationHome: collisionHome,
    operation: "test.collision",
    existingIndexMarkers: ["manifest.json"],
  });
  await writeFile(join(reservation.stagingHome, "entities.jsonl"), "ours\n");
  await writeFile(join(collisionHome, "entities.jsonl"), "foreign entities\n");
  assert.throws(
    () => reservation.publish(() => undefined),
    /already exists|refusing to overwrite/i,
  );
  assert.equal(
    await readFile(join(collisionHome, "entities.jsonl"), "utf8"),
    "foreign entities\n",
    "the colliding foreign child is never overwritten",
  );
  reservation.abort();
});

test("a lost reservation lock fences publication and abort preserves foreign data", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-reserve-lostlock-");
  const { legacyHome } = await makeLegacySource(t, parent);
  const destinationRoot = join(parent, "destination");
  await mkdir(join(destinationRoot, "docs"), { recursive: true });
  await writeFile(
    join(destinationRoot, "docs", "guide.md"),
    FIXTURES["docs/guide.md"],
  );
  const destinationHome = join(destinationRoot, ".zvec-grep");
  const lockDir = join(destinationHome, "locks", "home.write");

  const replaceLock = () => {
    rmSync(lockDir, { recursive: true, force: true });
    for (let i = 0; i < 64; i++) {
      mkdirSync(join(destinationRoot, `churn-${i}`));
    }
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "lock.json"),
      `${JSON.stringify(
        {
          token: "competitor-token",
          pid: process.pid,
          hostname: "this-host",
          startedAt: Date.now(),
          operation: "competitor",
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(destinationHome, "foreign.txt"), "competitor data");
  };

  // Publication with a replaced lock: fenced, competitor's lock preserved,
  // nothing merged.
  await assert.rejects(
    migrateWorkspaceIndex({
      sourceHome: legacyHome,
      destinationRoot,
      onProgress: (stage) => {
        if (stage === "verify") {
          replaceLock();
        }
      },
    }),
    /ownership.*lost|RESERVATION/i,
  );
  assert.equal(
    await readFile(join(destinationHome, "foreign.txt"), "utf8"),
    "competitor data",
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(lockDir, "lock.json"), "utf8")).token,
    "competitor-token",
    "the competitor's lock must survive the fenced publication",
  );
  assert.ok(
    !(await readdir(destinationHome)).includes("manifest.json"),
    "nothing is published after ownership loss",
  );
});

test("import honors the artifact's writer lock", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-reserve-artifact-lock-");
  const { legacyHome } = await makeLegacySource(t, parent);
  const artifact = join(parent, "artifact");
  await exportWorkspaceIndex({
    sourceHome: legacyHome,
    artifactPath: artifact,
  });

  const { acquireReadWriteLock } =
    await import("../../dist/engine/utils/lock.js");
  const writer = acquireReadWriteLock(
    join(artifact, "locks", "home"),
    "write",
    { operation: "index.export" },
  );
  try {
    await assert.rejects(
      importWorkspaceIndex({
        artifactPath: artifact,
        destinationRoot: join(parent, "destination"),
      }),
      (error) => error.code === "ZVEC_GREP.ENGINE.LOCK.BUSY",
      "import must not consume an artifact while its writer lock is held",
    );
  } finally {
    writer.release();
  }

  // After the writer releases (commit), the same artifact imports cleanly.
  const result = await importWorkspaceIndex({
    artifactPath: artifact,
    destinationRoot: join(parent, "destination"),
  });
  assert.equal(result.verification.countsMatch, true);
});

test("a failed rollback keeps the destination blocked instead of serving the ancestor", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-reserve-rollback-");

  // Ancestor workspace with a working index.
  await mkdir(join(parent, "docs"), { recursive: true });
  await writeFile(
    join(parent, "docs", "ancestor.md"),
    "# Ancestor\n\nAncestor content.\n",
  );
  const parentService = await createZvecGrep({
    root: parent,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await parentService.index();
  await parentService.close();

  const child = join(parent, "child");
  const destinationHome = join(child, ".zvec-grep");
  await mkdir(child, { recursive: true });
  await writeFile(join(child, "docs.md"), "# Child\n\nChild content.\n");

  const danglingTarget = join(parent, "no-such-target");
  const reservation = reserveDestination({
    destinationHome,
    operation: "test.failed-rollback",
    existingIndexMarkers: ["manifest.json"],
    testHooks: {
      afterChildMove(child) {
        if (child !== "payload.txt") {
          return;
        }
        // Between the first move and the next: a foreign dangling link
        // appears at the moved child's staging target, and a foreign file
        // occupies the next move's destination. Rollback must refuse to
        // overwrite the link instead of carrying it into staging.
        symlinkSync(danglingTarget, join(reservation.stagingHome, child));
        writeFileSync(join(destinationHome, "manifest.json"), "foreign\n");
      },
    },
  });
  await writeFile(join(reservation.stagingHome, "payload.txt"), "ours");

  assert.throws(
    () =>
      reservation.publish(() => {
        writeFileSync(join(reservation.stagingHome, "manifest.json"), "{}");
      }),
    /rollback is incomplete/i,
  );

  // The foreign link is preserved at the staging target; the published child
  // remains at the destination (not moved back, not deleted); the foreign
  // destination entry is preserved.
  assert.equal(
    readlinkSync(join(reservation.stagingHome, "payload.txt")),
    danglingTarget,
  );
  assert.equal(
    await readFile(join(destinationHome, "payload.txt"), "utf8"),
    "ours",
  );
  assert.equal(
    await readFile(join(destinationHome, "manifest.json"), "utf8"),
    "foreign\n",
  );
  // Blockage is preserved by the durable marker.
  assert.ok(existsSync(join(destinationHome, "INCOMPLETE")));
  // Readers from the child are blocked rather than served by the ancestor.
  const service = await createZvecGrep({
    root: child,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await assert.rejects(
    service.context({ query: "ancestor content", limit: 3 }),
    /incomplete|INCOMPLETE/i,
    "a failed rollback must never expose the ancestor fallback",
  );
  await service.close();

  // Abort after the failed publish does not weaken the blockage.
  reservation.abort();
  assert.ok(
    lstatSync(join(reservation.stagingHome, "payload.txt")).isSymbolicLink(),
  );
  assert.ok(existsSync(join(destinationHome, "INCOMPLETE")));
});

test("publication fails when the marker is replaced by foreign state", async (t) => {
  const parent = await createTemporaryDirectory(
    t,
    "zg-reserve-foreign-marker-",
  );
  const destinationHome = join(parent, "destination", ".zvec-grep");
  await mkdir(join(parent, "destination"), { recursive: true });
  const reservation = reserveDestination({
    destinationHome,
    operation: "test.foreign-marker",
    existingIndexMarkers: ["manifest.json"],
  });
  await writeFile(join(reservation.stagingHome, "payload.txt"), "ours");
  const foreignMarker = `${JSON.stringify({ token: "foreign-token" })}\n`;

  assert.throws(
    () =>
      reservation.publish(() => {
        writeFileSync(join(reservation.stagingHome, "manifest.json"), "{}");
        writeFileSync(join(destinationHome, "INCOMPLETE"), foreignMarker);
      }),
    /replaced by foreign state/i,
  );

  // The foreign marker is preserved exactly; publication rolled back.
  assert.equal(
    await readFile(join(destinationHome, "INCOMPLETE"), "utf8"),
    foreignMarker,
  );
  assert.equal(
    await readFile(join(reservation.stagingHome, "payload.txt"), "utf8"),
    "ours",
  );
  assert.ok(!existsSync(join(destinationHome, "payload.txt")));
  // The destination remains blocked for readers, and the lock was released.
  assert.throws(() => readWorkspaceManifest(destinationHome), /incomplete/i);
  assert.ok(!existsSync(join(destinationHome, "locks", "home.write")));
});

test("publication fails when the marker vanishes and restores the blockage", async (t) => {
  const parent = await createTemporaryDirectory(t, "zg-reserve-lost-marker-");
  const destinationHome = join(parent, "destination", ".zvec-grep");
  await mkdir(join(parent, "destination"), { recursive: true });
  const reservation = reserveDestination({
    destinationHome,
    operation: "test.lost-marker",
    existingIndexMarkers: ["manifest.json"],
  });
  await writeFile(join(reservation.stagingHome, "payload.txt"), "ours");

  assert.throws(
    () =>
      reservation.publish(() => {
        writeFileSync(join(reservation.stagingHome, "manifest.json"), "{}");
        rmSync(join(destinationHome, "INCOMPLETE"));
      }),
    /unexpectedly absent/i,
  );

  // Blockage is restored with this reservation's token; payload rolled back.
  const marker = JSON.parse(
    await readFile(join(destinationHome, "INCOMPLETE"), "utf8"),
  );
  assert.equal(marker.operation, "rollback-block");
  assert.equal(
    await readFile(join(reservation.stagingHome, "payload.txt"), "utf8"),
    "ours",
  );
  assert.throws(() => readWorkspaceManifest(destinationHome), /incomplete/i);
});

test("an incomplete rollback with a missing marker restores the marker and reports recovery", async (t) => {
  const parent = await createTemporaryDirectory(t, "zg-reserve-remarker-");
  const destinationHome = join(parent, "destination", ".zvec-grep");
  await mkdir(join(parent, "destination"), { recursive: true });
  const danglingTarget = join(parent, "no-such-target");
  const reservation = reserveDestination({
    destinationHome,
    operation: "test.remarker",
    existingIndexMarkers: ["manifest.json"],
    testHooks: {
      afterChildMove(child) {
        // Block the child's return and remove the durable marker.
        symlinkSync(danglingTarget, join(reservation.stagingHome, child));
        rmSync(join(destinationHome, "INCOMPLETE"));
      },
    },
  });
  await writeFile(join(reservation.stagingHome, "payload.txt"), "ours");

  assert.throws(
    () => reservation.publish(() => undefined),
    /rollback is incomplete/i,
  );

  // The marker is restored (ownership was verifiable) and the destination
  // stays blocked with the partial payload in place; the foreign link at the
  // staging target is preserved.
  const marker = JSON.parse(
    await readFile(join(destinationHome, "INCOMPLETE"), "utf8"),
  );
  assert.equal(marker.operation, "rollback-block");
  assert.equal(
    readlinkSync(join(reservation.stagingHome, "payload.txt")),
    danglingTarget,
  );
  assert.equal(
    await readFile(join(destinationHome, "payload.txt"), "utf8"),
    "ours",
  );
  assert.throws(() => readWorkspaceManifest(destinationHome), /incomplete/i);
});

test("an incomplete rollback preserves a foreign marker and releases the lock", async (t) => {
  const parent = await createTemporaryDirectory(t, "zg-reserve-foreignkeep-");
  const destinationHome = join(parent, "destination", ".zvec-grep");
  await mkdir(join(parent, "destination"), { recursive: true });
  const danglingTarget = join(parent, "no-such-target");
  const foreignMarker = `${JSON.stringify({ token: "foreign-token" })}\n`;
  const reservation = reserveDestination({
    destinationHome,
    operation: "test.foreignkeep",
    existingIndexMarkers: ["manifest.json"],
    testHooks: {
      afterChildMove(child) {
        symlinkSync(danglingTarget, join(reservation.stagingHome, child));
        writeFileSync(join(destinationHome, "INCOMPLETE"), foreignMarker);
      },
    },
  });
  await writeFile(join(reservation.stagingHome, "payload.txt"), "ours");

  assert.throws(
    () => reservation.publish(() => undefined),
    /rollback is incomplete/i,
  );

  // The foreign marker is never overwritten; the lock is released because
  // the foreign marker itself blocks the destination.
  assert.equal(
    await readFile(join(destinationHome, "INCOMPLETE"), "utf8"),
    foreignMarker,
  );
  assert.equal(
    readlinkSync(join(reservation.stagingHome, "payload.txt")),
    danglingTarget,
  );
  assert.ok(!existsSync(join(destinationHome, "locks", "home.write")));
  assert.throws(() => readWorkspaceManifest(destinationHome), /incomplete/i);
});

test("an incomplete rollback with an unrestorable marker retains the write lock", async (t) => {
  const parent = await createTemporaryDirectory(t, "zg-reserve-retainlock-");
  const destinationHome = join(parent, "destination", ".zvec-grep");
  await mkdir(join(parent, "destination"), { recursive: true });
  // Whether mode bits can make the home unwritable is a platform
  // capability, measured independently inside the hook.
  let homeUnwritable = false;
  const reservation = reserveDestination({
    destinationHome,
    operation: "test.retainlock",
    existingIndexMarkers: ["manifest.json"],
    testHooks: {
      afterChildMove() {
        // The marker vanishes and the home becomes unwritable: rollback
        // cannot move the child back and the marker cannot be restored.
        rmSync(join(destinationHome, "INCOMPLETE"));
        chmodSync(destinationHome, 0o555);
        try {
          writeFileSync(join(destinationHome, ".write-probe"), "");
          rmSync(join(destinationHome, ".write-probe"), { force: true });
        } catch (error) {
          homeUnwritable = error.code === "EACCES";
        }
      },
    },
  });
  await writeFile(join(reservation.stagingHome, "payload.txt"), "ours");

  assert.throws(
    () => reservation.publish(() => undefined),
    /unexpectedly absent/i,
  );
  // The unwritable home was only needed to fail the rollback and restore;
  // restore permissions before assertions and cleanup.
  chmodSync(destinationHome, 0o755);

  if (!homeUnwritable) {
    // Advisory mode bits: the intended fault never occurred; the engine
    // detects the vanished marker and rolls the publication back
    // completely, restoring the blockage (the "publication fails when
    // the marker vanishes" behavior).
    const marker = JSON.parse(
      await readFile(join(destinationHome, "INCOMPLETE"), "utf8"),
    );
    assert.equal(marker.operation, "rollback-block");
    assert.equal(
      await readFile(join(reservation.stagingHome, "payload.txt"), "utf8"),
      "ours",
    );
    assert.throws(() => readWorkspaceManifest(destinationHome), /incomplete/i);
    return;
  }

  // The write lock is retained as the last block; nothing else was written.
  const lockInfo = JSON.parse(
    await readFile(
      join(destinationHome, "locks", "home.write", "lock.json"),
      "utf8",
    ),
  );
  assert.equal(typeof lockInfo.token, "string");
  assert.ok(!existsSync(join(destinationHome, "INCOMPLETE")));
  assert.equal(
    await readFile(join(destinationHome, "payload.txt"), "utf8"),
    "ours",
  );

  // Abort must not release the retained lock or weaken the blockage.
  reservation.abort();
  assert.ok(existsSync(join(destinationHome, "locks", "home.write")));
  assert.throws(
    () =>
      assertNoWriteLock(join(destinationHome, "locks", "home"), "competitor"),
    (error) => error.code === "ZVEC_GREP.ENGINE.LOCK.BUSY",
    "the retained write lock keeps writers out",
  );

  // Discovery is blocked by the retained lock rather than falling back.
  const service = await createZvecGrep({
    root: join(parent, "destination"),
    embeddingModel: new FakeEmbeddingModel(),
  });
  await assert.rejects(
    service.context({ query: "anything", limit: 1 }),
    (error) => error.code === "ZVEC_GREP.ENGINE.LOCK.BUSY",
  );
  await service.close();

  // Documented operator recovery: quiesce writers, remove the lock directory
  // and the partial contents; publication then succeeds.
  await rm(join(destinationHome, "locks"), { recursive: true, force: true });
  await rm(join(destinationHome, "payload.txt"));
  await rm(reservation.stagingHome, { recursive: true, force: true });
  const recovered = reserveDestination({
    destinationHome,
    operation: "test.recovery",
    existingIndexMarkers: ["manifest.json"],
  });
  writeFileSync(join(recovered.stagingHome, "manifest.json"), "{}");
  recovered.publish(() => undefined);
  assert.ok(existsSync(join(destinationHome, "manifest.json")));
});

test("publication rejects a dangling destination child without overwriting it", async (t) => {
  const parent = await createTemporaryDirectory(t, "zg-reserve-dangling-");
  const destinationHome = join(parent, "destination", ".zvec-grep");
  await mkdir(join(parent, "destination"), { recursive: true });
  const reservation = reserveDestination({
    destinationHome,
    operation: "test.dangling-target",
    existingIndexMarkers: ["manifest.json"],
  });
  await writeFile(join(reservation.stagingHome, "payload.txt"), "ours");
  // A foreign dangling link already occupies the publication target: it is
  // an occupied pathname, never an empty destination.
  const danglingTarget = join(parent, "no-such-target");
  symlinkSync(danglingTarget, join(destinationHome, "payload.txt"));

  assert.throws(
    () =>
      reservation.publish(() => {
        writeFileSync(join(reservation.stagingHome, "manifest.json"), "{}");
      }),
    /already exists|refusing to overwrite/i,
  );

  // The foreign link's target and entry identity are unchanged.
  assert.equal(
    readlinkSync(join(destinationHome, "payload.txt")),
    danglingTarget,
  );
  assert.ok(lstatSync(join(destinationHome, "payload.txt")).isSymbolicLink());
  // Nothing moved; the staged payload remains in staging and the destination
  // stays blocked.
  assert.equal(
    await readFile(join(reservation.stagingHome, "payload.txt"), "utf8"),
    "ours",
  );
  assert.throws(() => readWorkspaceManifest(destinationHome), /incomplete/i);
});

test("publication validates every staged entry type before the first move", async (t) => {
  const parent = await createTemporaryDirectory(t, "zg-reserve-types-");
  const destinationHome = join(parent, "destination", ".zvec-grep");
  await mkdir(join(parent, "destination"), { recursive: true });
  const reservation = reserveDestination({
    destinationHome,
    operation: "test.entry-types",
    existingIndexMarkers: ["manifest.json"],
  });
  // Directories are legitimate staged children (native collections); a
  // symlink is not. Validation happens before any move, so the legitimate
  // child must not move either.
  await mkdir(join(reservation.stagingHome, "collection.zvec"), {
    recursive: true,
  });
  const linkTarget = join(parent, "elsewhere.txt");
  await writeFile(linkTarget, "elsewhere");
  symlinkSync(linkTarget, join(reservation.stagingHome, "evil.txt"));

  assert.throws(
    () =>
      reservation.publish(() => {
        writeFileSync(join(reservation.stagingHome, "manifest.json"), "{}");
      }),
    /unsupported entry type/i,
  );

  assert.equal(
    readlinkSync(join(reservation.stagingHome, "evil.txt")),
    linkTarget,
  );
  assert.ok(
    !existsSync(join(destinationHome, "collection.zvec")),
    "no child moved before the type rejection",
  );
  assert.throws(() => readWorkspaceManifest(destinationHome), /incomplete/i);
});

test("replacement staging installed before publish is rejected before any move", async (t) => {
  const parent = await createTemporaryDirectory(t, "zg-reserve-swap-pre-");
  const destinationHome = join(parent, "destination", ".zvec-grep");
  await mkdir(join(parent, "destination"), { recursive: true });
  const reservation = reserveDestination({
    destinationHome,
    operation: "test.staging-swap-pre",
    existingIndexMarkers: ["manifest.json"],
  });
  await writeFile(join(reservation.stagingHome, "payload.txt"), "ours");

  // Move the original staging aside and install a replacement with foreign
  // content before publication starts.
  const asideHome = `${reservation.stagingHome}-aside`;
  renameSync(reservation.stagingHome, asideHome);
  await mkdir(reservation.stagingHome, { recursive: true });
  await writeFile(join(reservation.stagingHome, "foreign.txt"), "not ours");

  assert.throws(
    () => reservation.publish(() => undefined),
    /staging.*(lost|replaced)|ownership/i,
  );

  // The replacement's content is preserved in place; the original staging
  // is preserved aside; nothing was moved into the destination.
  assert.equal(
    await readFile(join(reservation.stagingHome, "foreign.txt"), "utf8"),
    "not ours",
  );
  assert.equal(await readFile(join(asideHome, "payload.txt"), "utf8"), "ours");
  assert.ok(!existsSync(join(destinationHome, "foreign.txt")));
  assert.ok(!existsSync(join(destinationHome, "payload.txt")));
});

test("replacement staging installed inside finalization is rejected before enumeration", async (t) => {
  const parent = await createTemporaryDirectory(t, "zg-reserve-swap-fin-");
  const destinationHome = join(parent, "destination", ".zvec-grep");
  await mkdir(join(parent, "destination"), { recursive: true });
  const reservation = reserveDestination({
    destinationHome,
    operation: "test.staging-swap-finalize",
    existingIndexMarkers: ["manifest.json"],
  });
  await writeFile(join(reservation.stagingHome, "payload.txt"), "ours");
  const asideHome = `${reservation.stagingHome}-aside`;

  assert.throws(
    () =>
      reservation.publish(() => {
        renameSync(reservation.stagingHome, asideHome);
        mkdirSync(reservation.stagingHome, { recursive: true });
        writeFileSync(join(reservation.stagingHome, "foreign.txt"), "not ours");
      }),
    /staging.*(lost|replaced)|ownership/i,
  );

  assert.equal(
    await readFile(join(reservation.stagingHome, "foreign.txt"), "utf8"),
    "not ours",
  );
  assert.equal(await readFile(join(asideHome, "payload.txt"), "utf8"), "ours");
  assert.ok(!existsSync(join(destinationHome, "foreign.txt")));
});

test("a complete rollback with an unreadable marker stays blocked with a live ancestor", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-reserve-unread-marker-");

  await mkdir(join(parent, "docs"), { recursive: true });
  await writeFile(
    join(parent, "docs", "ancestor.md"),
    "# Ancestor\n\nAncestor content.\n",
  );
  const parentService = await createZvecGrep({
    root: parent,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await parentService.index();
  await parentService.close();

  const child = join(parent, "child");
  const destinationHome = join(child, ".zvec-grep");
  await mkdir(child, { recursive: true });
  await writeFile(join(child, "docs.md"), "# Child\n\nChild content.\n");

  const danglingMarkerTarget = join(parent, "no-such-marker-target");
  const reservation = reserveDestination({
    destinationHome,
    operation: "test.unreadable-marker",
    existingIndexMarkers: ["manifest.json"],
    testHooks: {
      afterChildMove() {
        // Replace the marker with a dangling symlink: present as an entry,
        // unreadable as a marker, and never overwritten.
        rmSync(join(destinationHome, "INCOMPLETE"));
        symlinkSync(danglingMarkerTarget, join(destinationHome, "INCOMPLETE"));
      },
    },
  });
  await writeFile(join(reservation.stagingHome, "payload.txt"), "ours");

  assert.throws(
    () => reservation.publish(() => undefined),
    /unreadable at publication/i,
  );

  // The payload rolled back into staging; the unreadable marker entry is
  // preserved exactly; the lock was released because the entry blocks.
  assert.equal(
    await readFile(join(reservation.stagingHome, "payload.txt"), "utf8"),
    "ours",
  );
  assert.equal(
    readlinkSync(join(destinationHome, "INCOMPLETE")),
    danglingMarkerTarget,
  );
  assert.ok(!existsSync(join(destinationHome, "locks", "home.write")));

  // Readers from the child are blocked rather than served by the ancestor.
  const service = await createZvecGrep({
    root: child,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await assert.rejects(
    service.context({ query: "ancestor content", limit: 3 }),
    /incomplete|INCOMPLETE/i,
    "an unreadable marker entry must keep blocking discovery",
  );
  await service.close();
});

test("abort with an unremovable staging payload preserves blockage and reports it", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-reserve-abortcleanup-");

  // Live ancestor index.
  await mkdir(join(parent, "docs"), { recursive: true });
  await writeFile(
    join(parent, "docs", "ancestor.md"),
    "# Ancestor\n\nAncestor content.\n",
  );
  const parentService = await createZvecGrep({
    root: parent,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await parentService.index();
  await parentService.close();

  const child = join(parent, "child");
  const destinationHome = join(child, ".zvec-grep");
  await mkdir(child, { recursive: true });
  await writeFile(join(child, "docs.md"), "# Child\n\nChild content.\n");

  const reservation = reserveDestination({
    destinationHome,
    operation: "test.abort-cleanup",
    existingIndexMarkers: ["manifest.json"],
  });
  // Real permission failure, no syscall mocking: a read-only staged
  // subdirectory cannot be emptied, so recursive staging removal fails.
  const protectedDir = join(reservation.stagingHome, "protected");
  await mkdir(protectedDir, { recursive: true });
  await writeFile(
    join(protectedDir, "payload.txt"),
    "owned recoverable payload",
  );
  chmodSync(protectedDir, 0o500);
  const unlinkControl = await import("node:fs/promises").then((fs) =>
    fs.unlink(join(protectedDir, "payload.txt")).catch((error) => error.code),
  );

  const cleanup = reservation.abort();
  // Restore normal access before any discovery check: permission failure
  // itself must not be mistaken for persistent protection.
  if (existsSync(protectedDir)) {
    chmodSync(protectedDir, 0o700);
  }

  if (unlinkControl !== "EACCES") {
    // Advisory mode bits: the staged payload is removable, so the cleanup
    // completes — staging is emptied and the blockage lifts.
    assert.equal(cleanup, undefined);
    assert.ok(!existsSync(protectedDir));
    assert.ok(!existsSync(join(destinationHome, "INCOMPLETE")));
    assert.ok(!existsSync(join(destinationHome, "locks", "home.write")));
    return;
  }

  // The cleanup failure is reported (the errno is the platform's cleanup
  // failure: EACCES from the denied unlink on Linux, ENOTEMPTY from
  // macOS's recursive removal), the payload remains, the marker is
  // preserved as blockage, and the lock is released against it.
  assert.match(cleanup, /could not be removed \((EACCES|ENOTEMPTY)\)/i);
  assert.match(cleanup, /blocked by the INCOMPLETE marker/i);
  assert.ok(existsSync(join(protectedDir, "payload.txt")));
  assert.ok(existsSync(join(destinationHome, "INCOMPLETE")));
  assert.ok(!existsSync(join(destinationHome, "locks", "home.write")));

  // With access restored and a live ancestor, writers and discovery are
  // denied; the ancestor is not served.
  const service = await createZvecGrep({
    root: child,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await assert.rejects(
    service.context({ query: "ancestor content", limit: 3 }),
    /incomplete|INCOMPLETE/i,
  );
  await service.close();

  // Documented operator recovery: remove the marker and partial contents,
  // then the workspace publishes normally.
  await rm(join(destinationHome, "INCOMPLETE"));
  await rm(reservation.stagingHome, { recursive: true, force: true });
  const recovered = reserveDestination({
    destinationHome,
    operation: "test.recovery",
    existingIndexMarkers: ["manifest.json"],
  });
  writeFileSync(join(recovered.stagingHome, "manifest.json"), "{}");
  recovered.publish(() => undefined);
  assert.ok(existsSync(join(destinationHome, "manifest.json")));
});

test("a permission failure retains the write lock and operator recovery restores the workspace", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-reserve-permrec-");

  await mkdir(join(parent, "docs"), { recursive: true });
  await writeFile(
    join(parent, "docs", "ancestor.md"),
    "# Ancestor\n\nAncestor content.\n",
  );
  const parentService = await createZvecGrep({
    root: parent,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await parentService.index();
  await parentService.close();

  const child = join(parent, "child");
  const destinationHome = join(child, ".zvec-grep");
  await mkdir(child, { recursive: true });

  // Permission-failure and recovery coverage: an unreadable home also hides
  // the lock metadata, so even the release path refuses deletion. This
  // fixture cannot distinguish the marker decision itself — that is the
  // pinned marker-only inspection probe's role (validation evidence).
  // Whether mode bits can make the home unreadable is a platform
  // capability, measured independently inside the hook.
  let homeUnreadable = false;
  const reservation = reserveDestination({
    destinationHome,
    operation: "test.permission-recovery",
    existingIndexMarkers: ["manifest.json"],
    testHooks: {
      afterChildMove() {
        rmSync(join(destinationHome, "INCOMPLETE"));
        chmodSync(destinationHome, 0o000);
        try {
          readdirSync(destinationHome);
        } catch (error) {
          homeUnreadable = error.code === "EACCES";
        }
      },
    },
  });
  await writeFile(join(reservation.stagingHome, "payload.txt"), "ours");

  let publishError;
  try {
    reservation.publish(() => undefined);
  } catch (error) {
    publishError = error;
  }
  assert.ok(publishError, "publication must fail");
  // Denied mode bits make the marker uninspectable ("ownership was lost";
  // retained lock); advisory mode bits leave the marker visibly absent
  // ("unexpectedly absent"; complete rollback). The outcome decides.
  assert.match(
    String(publishError),
    homeUnreadable ? /retained as the last block/i : /unexpectedly absent/i,
  );
  // Restore normal access before any discovery check.
  chmodSync(destinationHome, 0o755);

  if (!homeUnreadable) {
    // Advisory mode bits: the intended fault never occurred; the engine
    // rolls the publication back completely and restores the blockage
    // (the "publication fails when the marker vanishes" behavior). The
    // retained-lock and ancestor-recovery coverage below stays on the
    // denied branch; the rollback-interference path is deterministic via
    // the vanished-marker test.
    const marker = JSON.parse(
      await readFile(join(destinationHome, "INCOMPLETE"), "utf8"),
    );
    assert.equal(marker.operation, "rollback-block");
    assert.equal(
      await readFile(join(reservation.stagingHome, "payload.txt"), "utf8"),
      "ours",
    );
    assert.throws(() => readWorkspaceManifest(destinationHome), /incomplete/i);
    return;
  }

  // The lock is retained, the marker is absent, the payload remains at the
  // destination, and writers and discovery stay denied with a live ancestor.
  assert.ok(existsSync(join(destinationHome, "locks", "home.write")));
  assert.ok(!existsSync(join(destinationHome, "INCOMPLETE")));
  assert.equal(
    await readFile(join(destinationHome, "payload.txt"), "utf8"),
    "ours",
  );
  assert.throws(
    () =>
      assertNoWriteLock(join(destinationHome, "locks", "home"), "competitor"),
    (error) => error.code === "ZVEC_GREP.ENGINE.LOCK.BUSY",
  );
  const service = await createZvecGrep({
    root: child,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await assert.rejects(
    service.context({ query: "ancestor content", limit: 3 }),
    (error) => error.code === "ZVEC_GREP.ENGINE.LOCK.BUSY",
  );
  await service.close();

  // Documented operator recovery: quiesce writers, remove the lock directory
  // and the partial contents; the workspace then serves the ancestor again.
  await rm(join(destinationHome, "locks"), { recursive: true, force: true });
  await rm(join(destinationHome, "payload.txt"));
  const recovered = await createZvecGrep({
    root: child,
    embeddingModel: new FakeEmbeddingModel(),
  });
  const result = await recovered.context({
    query: "ancestor content",
    limit: 3,
  });
  assert.ok(
    result.items.length > 0,
    "after recovery the ancestor serves again",
  );
  await recovered.close();
});

test("abort preserves a staging symlink alias and the moved-aside payload", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-reserve-alias-");

  await mkdir(join(parent, "docs"), { recursive: true });
  await writeFile(
    join(parent, "docs", "ancestor.md"),
    "# Ancestor\n\nAncestor content.\n",
  );
  const parentService = await createZvecGrep({
    root: parent,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await parentService.index();
  await parentService.close();

  const child = join(parent, "child");
  const destinationHome = join(child, ".zvec-grep");
  await mkdir(child, { recursive: true });

  const reservation = reserveDestination({
    destinationHome,
    operation: "test.staging-alias",
    existingIndexMarkers: ["manifest.json"],
  });
  await writeFile(
    join(reservation.stagingHome, "payload.txt"),
    "owned payload",
  );
  // Move the owned staging aside inside the destination, then alias the
  // original path to it. The alias is a replacement entry: never deleted,
  // never treated as the owned staging.
  const asideHome = join(destinationHome, "staging-aside");
  renameSync(reservation.stagingHome, asideHome);
  symlinkSync(asideHome, reservation.stagingHome);

  const cleanup = reservation.abort();

  assert.match(cleanup, /symlink/i);
  assert.match(cleanup, /blocked by the INCOMPLETE marker/i);
  assert.equal(readlinkSync(reservation.stagingHome), asideHome);
  assert.equal(
    await readFile(join(asideHome, "payload.txt"), "utf8"),
    "owned payload",
  );
  assert.ok(existsSync(join(destinationHome, "INCOMPLETE")));
  assert.ok(!existsSync(join(destinationHome, "locks", "home.write")));

  const service = await createZvecGrep({
    root: child,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await assert.rejects(
    service.context({ query: "ancestor content", limit: 3 }),
    /incomplete|INCOMPLETE/i,
    "an aliased staging replacement must keep the destination blocked",
  );
  await service.close();

  // Documented operator recovery: remove the marker, the alias and the
  // moved-aside payload; publication then succeeds.
  await rm(join(destinationHome, "INCOMPLETE"));
  rmSync(reservation.stagingHome);
  await rm(asideHome, { recursive: true, force: true });
  const recovered = reserveDestination({
    destinationHome,
    operation: "test.recovery",
    existingIndexMarkers: ["manifest.json"],
  });
  writeFileSync(join(recovered.stagingHome, "manifest.json"), "{}");
  recovered.publish(() => undefined);
  assert.ok(existsSync(join(destinationHome, "manifest.json")));
});

test("abort treats a vanished staging directory as unfinished cleanup", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-reserve-vanished-");

  await mkdir(join(parent, "docs"), { recursive: true });
  await writeFile(
    join(parent, "docs", "ancestor.md"),
    "# Ancestor\n\nAncestor content.\n",
  );
  const parentService = await createZvecGrep({
    root: parent,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await parentService.index();
  await parentService.close();

  const child = join(parent, "child");
  const destinationHome = join(child, ".zvec-grep");
  await mkdir(child, { recursive: true });

  const reservation = reserveDestination({
    destinationHome,
    operation: "test.staging-vanished",
    existingIndexMarkers: ["manifest.json"],
  });
  await writeFile(
    join(reservation.stagingHome, "payload.txt"),
    "owned payload",
  );
  // The staging pathname disappears without a replacement; its payload
  // remains elsewhere in the destination.
  const asideHome = join(destinationHome, "staging-aside");
  renameSync(reservation.stagingHome, asideHome);

  const cleanup = reservation.abort();

  assert.match(cleanup, /unexpectedly absent/i);
  assert.match(cleanup, /blocked by the INCOMPLETE marker/i);
  assert.equal(
    await readFile(join(asideHome, "payload.txt"), "utf8"),
    "owned payload",
  );
  assert.ok(existsSync(join(destinationHome, "INCOMPLETE")));
  assert.ok(!existsSync(join(destinationHome, "locks", "home.write")));

  const service = await createZvecGrep({
    root: child,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await assert.rejects(
    service.context({ query: "ancestor content", limit: 3 }),
    /incomplete|INCOMPLETE/i,
    "unexplained staging disappearance must keep the destination blocked",
  );
  await service.close();

  await rm(join(destinationHome, "INCOMPLETE"));
  await rm(asideHome, { recursive: true, force: true });
  const recovered = reserveDestination({
    destinationHome,
    operation: "test.recovery",
    existingIndexMarkers: ["manifest.json"],
  });
  writeFileSync(join(recovered.stagingHome, "manifest.json"), "{}");
  recovered.publish(() => undefined);
  assert.ok(existsSync(join(destinationHome, "manifest.json")));
});

test("a normal abort cleans up completely and releases the workspace", async (t) => {
  ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
  const parent = await createTemporaryDirectory(t, "zg-reserve-clean-abort-");

  await mkdir(join(parent, "docs"), { recursive: true });
  await writeFile(
    join(parent, "docs", "ancestor.md"),
    "# Ancestor\n\nAncestor content.\n",
  );
  const parentService = await createZvecGrep({
    root: parent,
    embeddingModel: new FakeEmbeddingModel(),
  });
  await parentService.index();
  await parentService.close();

  const child = join(parent, "child");
  const destinationHome = join(child, ".zvec-grep");
  await mkdir(child, { recursive: true });

  const reservation = reserveDestination({
    destinationHome,
    operation: "test.clean-abort",
    existingIndexMarkers: ["manifest.json"],
  });
  await writeFile(join(reservation.stagingHome, "payload.txt"), "ours");

  const cleanup = reservation.abort();

  // Verified complete cleanup: nothing blocks, nothing remains, no warning.
  assert.equal(cleanup, undefined);
  assert.ok(!existsSync(reservation.stagingHome));
  assert.ok(!existsSync(join(destinationHome, "INCOMPLETE")));
  assert.ok(!existsSync(join(destinationHome, "locks", "home.write")));

  // A clean workspace legitimately falls back to the ancestor index.
  const service = await createZvecGrep({
    root: child,
    embeddingModel: new FakeEmbeddingModel(),
  });
  const result = await service.context({ query: "ancestor content", limit: 3 });
  assert.ok(result.items.length > 0);
  await service.close();

  // And a fresh reservation publishes normally.
  const recovered = reserveDestination({
    destinationHome,
    operation: "test.recovery",
    existingIndexMarkers: ["manifest.json"],
  });
  writeFileSync(join(recovered.stagingHome, "manifest.json"), "{}");
  recovered.publish(() => undefined);
  assert.ok(existsSync(join(destinationHome, "manifest.json")));
});
