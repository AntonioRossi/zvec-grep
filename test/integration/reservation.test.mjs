import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

  reservation.abort();
  assert.equal(
    await readFile(join(reservation.stagingHome, "foreign.txt"), "utf8"),
    "not ours",
    "abort must not delete a staging replacement",
  );
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
