import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

test("an abandoned reservation is reclaimed through the dead-owner rule", async (t) => {
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
