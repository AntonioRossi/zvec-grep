import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireReadWriteLock,
  assertNoWriteLock,
} from "../../dist/engine/utils/lock.js";

const DEAD_PID = 99_999_999;
const AGED_MS = 48 * 60 * 60 * 1000;

async function makeHome(t, prefix = "zg-lock-") {
  const home = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

function lockPathFor(home) {
  return join(home, "locks", "home");
}

async function writeOwnerInfo(lockDir, overrides = {}) {
  const info = {
    token: "owner-token",
    pid: process.pid,
    hostname: hostname(),
    startedAt: Date.now() - AGED_MS,
    operation: "fixture",
    ...overrides,
  };
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, "lock.json"),
    `${JSON.stringify(info, null, 2)}\n`,
  );
  return info;
}

test("a live local owner's write lock is never reclaimed at any age", async (t) => {
  const home = await makeHome(t);
  const lockPath = lockPathFor(home);
  const lock = acquireReadWriteLock(lockPath, "write", { operation: "owner" });

  // Age the owner's metadata far beyond any threshold while it stays alive.
  const infoPath = join(`${lockPath}.write`, "lock.json");
  const info = JSON.parse(await readFile(infoPath, "utf8"));
  info.startedAt = Date.now() - AGED_MS;
  await writeFile(infoPath, `${JSON.stringify(info, null, 2)}\n`);
  await utimes(`${lockPath}.write`, new Date(0), new Date(0));

  assert.throws(
    () => acquireReadWriteLock(lockPath, "write", { operation: "competitor" }),
    (error) => error.code === "ZVEC_GREP.ENGINE.LOCK.BUSY",
  );
  assert.ok(
    await stat(`${lockPath}.write`).then(
      (s) => s.isDirectory(),
      () => false,
    ),
    "the live owner's lock must survive the competing acquisition",
  );

  lock.release();
  const competitor = acquireReadWriteLock(lockPath, "write", {
    operation: "competitor",
  });
  competitor.release();
});

test("a verified-dead local owner's lock is reclaimed", async (t) => {
  const home = await makeHome(t);
  const lockPath = lockPathFor(home);
  await writeOwnerInfo(`${lockPath}.write`, { pid: DEAD_PID });

  const lock = acquireReadWriteLock(lockPath, "write", {
    operation: "successor",
  });
  lock.release();
});

test("unknown ownership remains blocked and is never auto-reclaimed", async (t) => {
  const variants = {
    missing_metadata: async (lockDir) => {
      await mkdir(lockDir, { recursive: true });
      await utimes(lockDir, new Date(0), new Date(0));
    },
    corrupt_metadata: async (lockDir) => {
      await mkdir(lockDir, { recursive: true });
      await writeFile(join(lockDir, "lock.json"), "not json\n");
    },
    foreign_owner: async (lockDir) => {
      await writeOwnerInfo(lockDir, {
        hostname: "definitely-another-host",
        pid: DEAD_PID,
      });
    },
  };

  for (const [name, arrange] of Object.entries(variants)) {
    const home = await makeHome(t, `zg-lock-${name}-`);
    const lockPath = lockPathFor(home);
    await arrange(`${lockPath}.write`);

    assert.throws(
      () => assertNoWriteLock(lockPath, `probe-${name}`),
      (error) => error.code === "ZVEC_GREP.ENGINE.LOCK.BUSY",
      `${name} must remain blocked`,
    );
    assert.ok(
      await stat(`${lockPath}.write`).then(
        (s) => s.isDirectory(),
        () => false,
      ),
      `${name} lock directory must not be reclaimed automatically`,
    );

    // Explicit recovery: the operator removes the lock with writers
    // quiescent; availability is restored.
    await rm(`${lockPath}.write`, { recursive: true, force: true });
    const recovered = acquireReadWriteLock(lockPath, "write", {
      operation: "recovered",
    });
    recovered.release();
  }
});

test("release never deletes a replaced directory's lock or content", async (t) => {
  const parent = await makeHome(t, "zg-lock-release-");
  const home = join(parent, "workspace");
  await mkdir(home, { recursive: true });
  const lockPath = lockPathFor(home);
  const lock = acquireReadWriteLock(lockPath, "write", { operation: "owner" });

  // Replace the entire home with a different directory carrying a copied
  // token and its own metadata. Allocation churn keeps the replacement's
  // inode distinct from the original's; a same-inode replacement carrying a
  // copied token is physically indistinguishable by construction.
  const copiedInfo = JSON.parse(
    await readFile(join(`${lockPath}.write`, "lock.json"), "utf8"),
  );
  await rm(home, { recursive: true, force: true });
  for (let i = 0; i < 64; i++) {
    await mkdir(join(parent, `churn-${i}`));
  }
  await mkdir(`${lockPath}.write`, { recursive: true });
  await writeFile(
    join(`${lockPath}.write`, "lock.json"),
    `${JSON.stringify(copiedInfo, null, 2)}\n`,
  );
  await writeFile(join(`${lockPath}.write`, "sentinel.txt"), "not yours");

  lock.release();

  assert.equal(
    await readFile(join(`${lockPath}.write`, "sentinel.txt"), "utf8"),
    "not yours",
    "the replacement's content must survive the original release",
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(`${lockPath}.write`, "lock.json"), "utf8")),
    copiedInfo,
    "the replacement's lock metadata must survive the original release",
  );
});

test("reader locks follow the same three-state rule", async (t) => {
  const home = await makeHome(t, "zg-lock-readers-");
  const lockPath = lockPathFor(home);

  // Live local reader, arbitrarily old: the writer stays blocked.
  const liveReaderDir = join(
    `${lockPath}.readers`,
    `${process.pid}-live-token`,
  );
  await writeOwnerInfo(liveReaderDir, { token: "live-token" });
  assert.throws(
    () => acquireReadWriteLock(lockPath, "write", { operation: "writer" }),
    (error) => error.code === "ZVEC_GREP.ENGINE.LOCK.BUSY",
  );
  await rm(liveReaderDir, { recursive: true, force: true });

  // Dead local reader: reclaimed, writer proceeds.
  const deadReaderDir = join(`${lockPath}.readers`, `${DEAD_PID}-dead-token`);
  await writeOwnerInfo(deadReaderDir, { token: "dead-token", pid: DEAD_PID });
  const writer = acquireReadWriteLock(lockPath, "write", {
    operation: "writer",
  });
  writer.release();

  // A live local reader can be taken and released normally.
  const reader = acquireReadWriteLock(lockPath, "read", {
    operation: "reader",
  });
  reader.release();
});

test("busy errors carry explicit recovery guidance", async (t) => {
  const home = await makeHome(t, "zg-lock-hint-");
  const lockPath = lockPathFor(home);
  await writeOwnerInfo(`${lockPath}.write`, { hostname: "another-host" });

  assert.throws(
    () => assertNoWriteLock(lockPath, "probe"),
    (error) =>
      error.code === "ZVEC_GREP.ENGINE.LOCK.BUSY" &&
      /never reclaimed automatically/.test(error.context ?? ""),
  );
});
