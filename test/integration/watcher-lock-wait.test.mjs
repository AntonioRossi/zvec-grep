import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createZvecGrep } from "../../dist/index.js";
import { DaemonBackend } from "../../dist/daemon/backend.js";
import { JobScheduler } from "../../dist/daemon/job-scheduler.js";
import { acquireReadWriteLock } from "../../dist/engine/utils/lock.js";
import { CountingEmbeddingModel } from "../helpers/counting-embedding.mjs";
import { useIsolatedZvecGrepHome } from "../helpers/isolated-home.mjs";

useIsolatedZvecGrepHome();
test("F3 invalid lock deadlines cannot create an unbounded wait", () => {
  for (const lockWaitTimeoutMs of [Infinity, NaN, -1]) {
    assert.throws(
      () => new JobScheduler({ lockWaitTimeoutMs }),
      /finite and non-negative/,
    );
  }
});
const busy = () =>
  Object.assign(new Error("live reader owns the lock"), {
    code: "ZVEC_GREP.ENGINE.LOCK.BUSY",
  });
const changes = (file) => ({
  touchedFiles: [file],
  rescanDirectories: [],
  deletedPrefixes: [],
  forceFullReconcile: false,
});
const search = (root, query) => ({
  root,
  queries: [],
  routes: [{ mode: "fts", query }],
  limit: 10,
  autoUpdate: true,
  freshness: "wait_for_fresh",
});

test("F3 watcher preserves both change sets across a four-second info reader without blocking another root", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "zg-watch-lock-"));
  let service, backend, reader;
  t.after(async () => {
    reader?.release();
    await backend?.close();
    await service?.close();
    await rm(base, { recursive: true, force: true });
  });
  const directory = join(base, "workspace");
  await mkdir(directory);
  const root = await realpath(directory);
  const first = join(root, "first.md"),
    second = join(root, "second.md");
  await writeFile(first, "# First\noriginal alpha phrase\n");
  await writeFile(second, "# Second\noriginal beta phrase\n");
  service = await createZvecGrep({
    root,
    embeddingModel: new CountingEmbeddingModel(),
  });
  await service.index();
  await service.close();
  service = undefined;
  let watcher;
  backend = new DaemonBackend({
    version: "test",
    modelPoolOptions: { createModel: () => new CountingEmbeddingModel() },
    watchManagerFactory: (options) => {
      watcher = options;
      return {
        start() {
          options.onActiveChange(true);
        },
        flushPending: async () => {},
        close: async () => {},
      };
    },
  });
  await backend.search(search(root, "original"));
  // This is the same home read lock and operation that service.info() holds
  // for its complete filesystem scan. Keep its identity unchanged throughout.
  reader = acquireReadWriteLock(
    join(root, ".zvec-grep", "locks", "home"),
    "read",
    { operation: "info" },
  );
  const identity = readFileSync(join(reader.path, "lock.json"), "utf8");
  await writeFile(first, "# First\nmodified orchard phrase\n");
  await watcher.onChanges(changes(first));
  await delay(1100);
  assert.equal(
    backend.scheduler.getByRoot(root).state,
    "queued",
    "a temporary reader must not fail the watcher",
  );
  assert.equal(readFileSync(join(reader.path, "lock.json"), "utf8"), identity);
  await writeFile(second, "# Second\nmodified harbor phrase\n");
  await watcher.onChanges(changes(second));
  const other = backend.scheduler.submit({
    canonicalRoot: "/unrelated-test-root",
    reason: "manual",
    run: async () => {},
  });
  assert.equal((await backend.scheduler.wait(other.job.id)).state, "succeeded");
  await delay(2900);
  assert.equal(readFileSync(join(reader.path, "lock.json"), "utf8"), identity);
  assert.equal(reader.release(), true);
  reader = undefined;
  await backend.scheduler.waitForRootIdle(root);
  assert.equal(backend.scheduler.getByRoot(root).state, "succeeded");
  const status = await backend.indexStatus({ root });
  assert.equal(status.runtime.indexedRevision, status.runtime.dirtyRevision);
  for (const query of ["orchard", "harbor"])
    assert.ok(
      (await backend.search(search(root, query))).result.items.some((x) =>
        x.content.includes(query),
      ),
    );
});

test("F3 lock wait has a time bound independent of the short generic retry count", async (t) => {
  const scheduler = new JobScheduler({
    maxAttempts: 1,
    retryBaseDelayMs: 5,
    lockWaitTimeoutMs: 65,
  });
  t.after(() => scheduler.close());
  const start = performance.now();
  const job = scheduler.submit({
    canonicalRoot: "/locked",
    reason: "watch",
    run: async () => {
      throw busy();
    },
  });
  const result = await scheduler.wait(job.job.id);
  assert.equal(result.state, "failed");
  assert.equal(result.error.code, "ZVEC_GREP.ENGINE.LOCK.BUSY");
  assert.ok(result.attempt > 1);
  assert.ok(performance.now() - start >= 60);
  assert.ok(performance.now() - start < 2000);
});

test("F3 cancellation removes a pending lock retry without changing lock ownership", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "zg-watch-cancel-"));
  let lock;
  const scheduler = new JobScheduler({
    maxAttempts: 1,
    retryBaseDelayMs: 10,
    lockWaitTimeoutMs: 5000,
  });
  t.after(async () => {
    await scheduler.close();
    lock?.release();
    await rm(base, { recursive: true, force: true });
  });
  lock = acquireReadWriteLock(join(base, "home"), "read", {
    operation: "info",
  });
  const identity = readFileSync(join(lock.path, "lock.json"), "utf8");
  let attempts = 0;
  const job = scheduler.submit({
    canonicalRoot: base,
    reason: "watch",
    run: async () => {
      attempts++;
      const write = acquireReadWriteLock(join(base, "home"), "write", {
        operation: "index",
      });
      write.release();
    },
  });
  await delay(25);
  assert.equal(scheduler.get(job.job.id).state, "queued");
  assert.equal(scheduler.cancelRoot(base), true);
  assert.equal((await scheduler.wait(job.job.id)).state, "cancelled");
  const count = attempts;
  await delay(70);
  assert.equal(attempts, count);
  assert.equal(readFileSync(join(lock.path, "lock.json"), "utf8"), identity);
});
