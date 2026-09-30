import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createTemporaryDirectory,
  removeTemporaryDirectory,
  runCli,
} from "./helpers/fixtures.mjs";
import { createFakeEmbeddingServer } from "./helpers/fake-embedding.mjs";

// Portable heavy-fixture geometry, matching test/unit/glob.test.mjs: deep
// nesting with 90-character components keeps glob matching expensive while
// every created path stays inside a budget every supported platform accepts
// (macOS PATH_MAX is 1024 bytes including its /var/folders/.../T temp
// prefix; 200-character components overflow it — the 2026-09-29 macOS CI
// failures).
const DEEP_COMPONENT = "a".repeat(90);
const PROBE_FILE_NAME = `f${"g".repeat(160)}.ts`;
const PORTABLE_PATH_BUDGET = 1000;

/**
 * Parses a health response body into a daemon gap value. A valid health
 * envelope (`status: "ok"`) is required; inside it, absent telemetry means
 * a pre-monitor build (undefined = unknown), while a present value must be
 * a finite non-negative number. Anything else fails loudly.
 */
export function parseHealthGap(body) {
  if (body?.status !== "ok") {
    throw new Error(
      `health response is not a valid envelope: ${JSON.stringify(body)?.slice(0, 80)}`,
    );
  }
  const gap = body?.eventLoop?.maxGapMs;
  if (gap === undefined || gap === null) {
    return undefined;
  }
  if (typeof gap !== "number" || !Number.isFinite(gap) || gap < 0) {
    throw new Error(`malformed eventLoop.maxGapMs: ${gap}`);
  }
  return gap;
}

/**
 * The load window is defined by request START time: a request begun before
 * load and completed during it belongs to the pre-load window, not the
 * measured one.
 */
export function inLoadWindow(requestStartMs, loadStartedAtMs) {
  return loadStartedAtMs !== 0 && requestStartMs >= loadStartedAtMs;
}

/**
 * Retains the correlated load observations attribution actually needs. A
 * bounded buffer of ordinary qualifying samples may drop entries, but the
 * decisive observations can never disappear: the worst external request and
 * every new daemon-gap maximum are kept separately, each with its timestamp.
 * A late outlier — the worst external arriving after the buffer has filled —
 * is therefore always examinable alongside its daemon gap.
 */
export function createLoadSampleCollector(ordinaryLimit = 40) {
  let worstExternal;
  let worstExternalMs = -1;
  let gapMaximumMs = -1;
  const gapMaximums = [];
  const ordinary = [];
  const add = (entry) => {
    const { t, ext, gap } = entry;
    if (ext > worstExternalMs) {
      worstExternalMs = ext;
      worstExternal = entry;
    }
    if (typeof gap === "number" && gap > gapMaximumMs) {
      gapMaximumMs = gap;
      gapMaximums.push(entry);
    }
    if (ordinary.length < ordinaryLimit) {
      ordinary.push(entry);
    }
  };
  const qualifies = (entry) =>
    entry.ext > 50 || (typeof entry.gap === "number" && entry.gap > 50);
  return {
    observe(t, ext, gap) {
      const entry = { t, ext, gap };
      if (qualifies(entry)) add(entry);
    },
    entries() {
      const seen = new Set();
      const merged = [];
      for (const entry of [worstExternal, ...gapMaximums, ...ordinary]) {
        if (!entry) continue;
        const key = `${entry.t}:${entry.ext}:${entry.gap}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(entry);
      }
      return merged.sort((a, b) => a.t - b.t);
    },
  };
}

/**
 * CLI success timeouts must tolerate slow or coverage-instrumented runners.
 * CI run 36587089439 (coverage job, 2026-09-29) showed the measured index
 * exceeding a 180s cap under c8 on a 2-core runner while the same tree
 * passed without instrumentation: the cap, not the workload, failed the
 * probe. Slow-runner baseline doubles every cap; active V8 coverage
 * (NODE_V8_COVERAGE is inherited by every spawned process) triples it. The
 * probe's latency bound is unaffected — a longer cap only stops the success
 * predicate from manufacturing failures on slow environments.
 */
export function probeCliTimeoutMs(baseMs, env = process.env) {
  return env.NODE_V8_COVERAGE ? baseMs * 3 : baseMs * 2;
}

async function availablePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}

async function prepareHeavyFixture(parent, name) {
  const root = join(parent, name, "repo");
  let dir = root;
  for (let depth = 0; depth < 8; depth++) {
    dir = join(dir, DEEP_COMPONENT);
    assert.ok(
      dir.length + PROBE_FILE_NAME.length + 1 <= PORTABLE_PATH_BUDGET,
      `fixture path exceeds the portable budget: ${dir.length + PROBE_FILE_NAME.length + 1}`,
    );
    await mkdir(dir, { recursive: true });
  }
  await writeFile(
    join(dir, PROBE_FILE_NAME),
    "export const HealthProbeSymbol = 42;\n",
  );
  // 300 heavy rules against the deep paths (~35M units): the corrected head
  // admits and chunks the work while the withdrawn head evaluates it as one
  // monolithic block past the probe's 400ms bound (the scanner stall test
  // calibrated this same admitted geometry at 485ms on 2630dca; admission
  // holds to ~425 rules at this path length).
  const rules = Array.from(
    { length: 300 },
    (_, i) => "*a".repeat(100) + "*Z" + i,
  );
  await writeFile(join(root, ".gitignore"), `${rules.join("\n")}\n`);
  return root;
}

/**
 * One probe over a run-owned daemon: overlapping index+query load while an
 * independent loop polls a health URL. Fails unless (a) every health request
 * succeeds with 200, (b) at least `minOkPolls` successful responses arrive
 * during load, (c) steady-state worst latency stays under `maxMs` (warmup
 * excluded), (d) indexing reports success and (e) the query finds the symbol.
 */
async function runHealthProbe(options) {
  const {
    root,
    home,
    env,
    port,
    healthUrl,
    minOkPolls = 50,
    maxMs = 400,
    expectWorkloadSuccess = true,
    measureDaemonGap = true,
  } = options;
  await mkdir(join(home, ".zvec-grep"), { recursive: true });
  await writeFile(
    join(home, ".zvec-grep", "config.json"),
    `${JSON.stringify({
      version: 1,
      defaults: { embedding: "qwen/text-embedding-v4" },
    })}\n`,
  );
  const started = await runCli(
    ["--server", "on", "--listen", `127.0.0.1:${port}`, "--home", home],
    { cwd: root, env },
  );
  assert.match(started.stdout, /Server: ready/);

  let polling = true;
  let loadStartedAt = 0;
  let worstHealthMs = 0;
  let okPolls = 0;
  let loadOkPolls = 0;
  let daemonGapMs;
  const loadLatencies = [];
  const samples = createLoadSampleCollector();
  const failures = [];
  const healthUrl_ = healthUrl ?? `http://127.0.0.1:${port}/healthz`;
  const pollLoop = (async () => {
    while (polling) {
      const requestStart = Date.now();
      try {
        const response = await fetch(healthUrl_, {
          signal: AbortSignal.timeout(2_000),
        });
        const elapsed = Date.now() - requestStart;
        if (response.status !== 200) {
          failures.push(`status ${response.status}`);
        } else {
          okPolls++;
          let gap;
          try {
            gap = (await response.json())?.eventLoop?.maxGapMs;
          } catch {
            // A body read failure does not fail the poll itself.
          }
          // The window is defined by request START: a request begun before
          // load and completed during it must not be counted as in-load.
          if (inLoadWindow(requestStart, loadStartedAt)) {
            loadOkPolls++;
            loadLatencies.push(elapsed);
            worstHealthMs = Math.max(worstHealthMs, elapsed);
            // After the pre-load reset the cumulative value covers the load
            // window only. An absent field stays *unknown* — telemetry
            // presence is a separate contract, not a behavioral assertion.
            if (typeof gap === "number") {
              daemonGapMs = Math.max(daemonGapMs ?? 0, gap);
            }
            samples.observe(requestStart - loadStartedAt, elapsed, gap);
          }
        }
      } catch (error) {
        failures.push(String(error?.cause?.code ?? error?.message ?? error));
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
    }
  })();
  try {
    const warmupDeadline = Date.now() + 15_000;
    while (okPolls === 0 && Date.now() < warmupDeadline) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
    }
    assert.ok(okPolls > 0, "health endpoint never answered during warmup");

    // Expensive search filters: heavy globs evaluated against the fixture's
    // deep paths, alongside the matching pattern.
    const heavyGlobs = Array.from(
      { length: 100 },
      (_, i) => "*a".repeat(100) + "*Z" + i,
    );
    const queryArgs = [
      "--fts",
      "HealthProbeSymbol",
      "--limit",
      "1",
      "--refresh",
      "off",
      "--allow-remote",
      ...heavyGlobs.flatMap((glob) => ["--glob", glob]),
      "--glob",
      "*.ts",
    ];
    // Warmup completes only after the daemon has actually served workload on
    // the MEASURED target: a first index of the target repo opens its store
    // and prepares its model. Warmup failures propagate — a cold store must
    // never be measured as load.
    const timings = { warmupIndexMs: 0, measuredIndexMs: 0, queryMs: 0 };
    const warmupStartedAt = Date.now();
    const warmupIndex = await runCli(
      ["--index", "--mode", "server", "--allow-remote", root],
      { cwd: root, env, timeout: probeCliTimeoutMs(120_000) },
    );
    timings.warmupIndexMs = Date.now() - warmupStartedAt;
    assert.match(
      String(warmupIndex.stdout),
      /Workspace index: succeeded/,
      "warmup index of the target store failed",
    );
    // Mutate the fixture input so the measured index performs real work
    // (rescan plus heavy-rule matching) against the already-warm store.
    await writeFile(
      join(root, "mutation.ts"),
      "export const HealthProbeMutation = 7;\n",
    );
    // Attribute daemon-side gaps to the load window: read the cumulative
    // startup maximum, then reset the sampling epoch. Both requests are
    // bounded and validated — a measurement-setup failure fails the probe
    // loudly instead of silently measuring the wrong window.
    const readGap = async (reset) => {
      const response = await fetch(
        reset ? `${healthUrl_}?resetLoopGap=1` : healthUrl_,
        { signal: AbortSignal.timeout(2_000) },
      );
      assert.equal(
        response.status,
        200,
        `daemon gap ${reset ? "reset" : "read"} status ${response.status}`,
      );
      const body = await response.json();
      try {
        return parseHealthGap(body);
      } catch (error) {
        throw new Error(
          `daemon gap ${reset ? "reset" : "read"}: ${error?.message ?? error}`,
        );
      }
    };
    let startupGapMs;
    if (measureDaemonGap) {
      startupGapMs = await readGap(false);
      await readGap(true);
    }

    loadStartedAt = Date.now();
    const [indexed, queried] = await Promise.all([
      (async () => {
        const startedAt = Date.now();
        try {
          return await runCli(
            ["--index", "--mode", "server", "--allow-remote", root],
            {
              cwd: root,
              env,
              timeout: probeCliTimeoutMs(180_000),
            },
          );
        } finally {
          // Each CLI's duration is its own completion time, including
          // rejection — not a shared endpoint after polling drains.
          timings.measuredIndexMs = Date.now() - startedAt;
        }
      })().catch((error) => error),
      (async () => {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
        const startedAt = Date.now();
        try {
          return await runCli([...queryArgs, "--mode", "server"], {
            cwd: root,
            env,
            timeout: probeCliTimeoutMs(120_000),
          });
        } finally {
          timings.queryMs = Date.now() - startedAt;
        }
      })().catch((error) => error),
    ]);
    polling = false;
    await pollLoop;
    // A block landing after the last poll must still be counted: capture a
    // final cumulative sample once polling has drained.
    if (measureDaemonGap) {
      const finalGap = await readGap(false);
      if (typeof finalGap === "number") {
        daemonGapMs = Math.max(daemonGapMs ?? 0, finalGap);
      }
    }
    const timingsNote = ` (timings ms: warmup=${timings.warmupIndexMs} index=${timings.measuredIndexMs} query=${timings.queryMs})`;

    const problems = [];
    if (failures.length > 0) {
      problems.push(
        `${failures.length} health requests failed (${failures[0]})`,
      );
    }
    if (okPolls < minOkPolls) {
      problems.push(`only ${okPolls} successful health responses`);
    }
    if (loadOkPolls < 20) {
      problems.push(
        `only ${loadOkPolls} health responses during confirmed load`,
      );
    }
    if (worstHealthMs >= maxMs) {
      problems.push(`worst steady-state health latency ${worstHealthMs}ms`);
    }
    // Telemetry presence is asserted by the separate telemetry-contract
    // test; here an absent eventLoop.maxGapMs means the daemon-side gap is
    // *unknown*, not a behavioral failure — the latency assertions above
    // stand on their own.
    const latencyDistribution = (() => {
      if (loadLatencies.length === 0) return "n=0";
      const sorted = [...loadLatencies].sort((a, b) => a - b);
      const at = (quantile) =>
        sorted[
          Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))
        ];
      return `n=${sorted.length} p50=${at(0.5)}ms p95=${at(0.95)}ms max=${sorted[sorted.length - 1]}ms`;
    })();
    const indexedOk =
      !indexed?.code &&
      /Workspace index: succeeded/.test(String(indexed.stdout ?? ""));
    const queriedOk =
      queryResultProblems(queried, PROBE_FILE_NAME).length === 0;
    if (expectWorkloadSuccess) {
      if (!indexedOk)
        problems.push(
          `indexing did not succeed: ${String(indexed?.stderr ?? indexed)}`.slice(
            0,
            200,
          ) + timingsNote,
        );
      if (!queriedOk)
        problems.push(
          ...queryResultProblems(queried, PROBE_FILE_NAME).map(
            (problem) => `query result: ${problem}`,
          ),
          `query result timings${timingsNote}`,
        );
    }
    return {
      problems,
      worstHealthMs,
      okPolls,
      loadOkPolls,
      timings,
      daemonGapMs,
      startupGapMs,
      samples,
      latencyDistribution,
    };
  } finally {
    polling = false;
    await pollLoop;
  }
}

/**
 * A query result counts only with successful execution, a positive parsed
 * hit count, and the expected file among the matched entries — echoing the
 * query text alone proves nothing.
 */
function queryResultProblems(queried, expectedFileName) {
  const problems = [];
  const stdout = String(queried?.stdout ?? "");
  if (queried?.code) {
    problems.push(
      `query failed: ${String(queried?.stderr ?? queried).slice(0, 120)}`,
    );
    return problems;
  }
  const match = /hits: (\d+)/.exec(stdout);
  const hitCount = match ? Number.parseInt(match[1], 10) : 0;
  if (!match) {
    problems.push("query output has no parseable hit count");
  } else if (hitCount < 1) {
    problems.push(`query returned ${hitCount} hits`);
  }
  if (
    hitCount >= 1 &&
    !new RegExp(`matchedBy=\\S+ .*${expectedFileName}`).test(stdout)
  ) {
    problems.push(
      `expected file ${expectedFileName} not among matched entries`,
    );
  }
  return problems;
}

async function readInstanceRecord(home) {
  // The daemon stores its record under <home>/daemon/instance.lock
  // (daemonHome in src/daemon/config.ts).
  const recordPath = join(home, "daemon", "instance.lock");
  const content = await readFile(recordPath, "utf8").catch(() => null);
  if (content === null) return null;
  try {
    return { recordPath, record: JSON.parse(content) };
  } catch {
    return { recordPath, record: null };
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The single owner of cleanup, strictly ordered: identify the daemon from its
 * instance record before anything is removed, terminate it, confirm both
 * process exit and listener release, and only then allow directory removal.
 * If termination cannot be confirmed, the home and instance record stay in
 * place as ownership evidence and the failure is thrown.
 */
async function ownedTeardown({ home, root, env, port }) {
  const identified = await readInstanceRecord(home);
  const pid = identified?.record?.pid;
  await runCli(["--server", "off", "--home", home], { cwd: root, env }).catch(
    () => undefined,
  );
  if (typeof pid === "number" && pid > 0) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && processAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  let listenerReleased = false;
  try {
    await fetch(`http://127.0.0.1:${port}/healthz`);
  } catch {
    listenerReleased = true;
  }
  const exited = !(typeof pid === "number" && pid > 0 && processAlive(pid));
  if (!exited || !listenerReleased) {
    throw new Error(
      `daemon teardown unconfirmed (pid ${pid}, exited=${exited}, listenerReleased=${listenerReleased}); home and instance record preserved at ${home}`,
    );
  }
}

test("daemon /healthz stays responsive under overlapping load", async (t) => {
  const temporaryDirectory = await createTemporaryDirectory(
    t,
    "zvec-grep-health-probe-",
    {
      cleanup: false,
    },
  );
  const root = await prepareHeavyFixture(temporaryDirectory, ".");
  const home = join(temporaryDirectory, "home");
  const endpoint = await createFakeEmbeddingServer(t);
  const port = await availablePort();
  const env = {
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    ZVEC_GREP_API_KEY: "test-key",
    ZVEC_GREP_ENDPOINT: endpoint,
    ZVEC_GREP_HOME: home,
    ZVEC_GREP_SERVER_URL: `http://127.0.0.1:${port}/mcp`,
  };
  t.after(async () => {
    // Removal happens only after confirmed termination and listener release;
    // an unconfirmed teardown throws and the directories remain as evidence.
    await ownedTeardown({ home, root, env, port });
    await removeTemporaryDirectory(temporaryDirectory);
  });

  const {
    problems,
    worstHealthMs,
    okPolls,
    timings,
    daemonGapMs,
    startupGapMs,
    samples,
    latencyDistribution,
  } = await runHealthProbe({
    root,
    home,
    env,
    port,
  });
  // Attribution is evidence-constrained: a large daemon-side gap means the
  // daemon blocked or was descheduled (the sampler cannot separate the two);
  // a large external latency with a small daemon gap points at the observer
  // or runner scheduling; anything else stays unresolved. The correlated
  // samples below are the record for that analysis — no bound is chosen
  // from a single observation.
  t.diagnostic(
    `health-probe timings ms: ${JSON.stringify(timings)}; daemon gap startup=${startupGapMs} load=${daemonGapMs} (${typeof daemonGapMs === "number" ? "reported" : "unknown"}); external ${latencyDistribution}`,
  );
  for (const entry of samples.entries()) {
    t.diagnostic(
      `load-sample t=${entry.t}ms ext=${entry.ext} gap=${entry.gap ?? "n/a"}`,
    );
  }
  assert.deepEqual(problems, []);
  assert.ok(okPolls >= 50, `expected sustained polling, got ${okPolls}`);
  assert.ok(
    worstHealthMs < 400,
    `worst steady-state latency ${worstHealthMs}ms`,
  );
  await ownedTeardown({ home, root, env, port });
  await removeTemporaryDirectory(temporaryDirectory);
});

test("health probe negative control: unavailable health fails the probe", async (t) => {
  const temporaryDirectory = await createTemporaryDirectory(
    t,
    "zvec-grep-health-dead-",
    {
      cleanup: false,
    },
  );
  const root = await prepareHeavyFixture(temporaryDirectory, ".");
  const home = join(temporaryDirectory, "home");
  const endpoint = await createFakeEmbeddingServer(t);
  const port = await availablePort();
  const deadPort = await availablePort();
  const env = {
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    ZVEC_GREP_API_KEY: "test-key",
    ZVEC_GREP_ENDPOINT: endpoint,
    ZVEC_GREP_HOME: home,
    ZVEC_GREP_SERVER_URL: `http://127.0.0.1:${port}/mcp`,
  };
  t.after(async () => {
    // Removal happens only after confirmed termination and listener release;
    // an unconfirmed teardown throws and the directories remain as evidence.
    await ownedTeardown({ home, root, env, port });
    await removeTemporaryDirectory(temporaryDirectory);
  });
  // Polling a port with no listener: the probe must fail — either at warmup
  // (the endpoint never answers) or through reported request failures — even
  // though the daemon itself and its workload are healthy.
  let problems = null;
  let warmupThrew = null;
  try {
    ({ problems } = await runHealthProbe({
      root,
      home,
      env,
      port,
      healthUrl: `http://127.0.0.1:${deadPort}/healthz`,
      measureDaemonGap: false,
    }));
  } catch (error) {
    warmupThrew = error;
  }
  if (warmupThrew) {
    assert.match(warmupThrew.message, /never answered during warmup/);
  } else {
    assert.ok(
      problems.length > 0,
      "probe unexpectedly passed with no health listener",
    );
    assert.ok(
      problems.some((p) => /health requests failed|successful health/.test(p)),
      JSON.stringify(problems),
    );
  }
  await ownedTeardown({ home, root, env, port });
  await removeTemporaryDirectory(temporaryDirectory);
});

test("health probe negative control: failed workload fails the probe", async (t) => {
  const temporaryDirectory = await createTemporaryDirectory(
    t,
    "zvec-grep-health-broken-",
    {
      cleanup: false,
    },
  );
  const root = await prepareHeavyFixture(temporaryDirectory, ".");
  const home = join(temporaryDirectory, "home");
  const deadEndpoint = `http://127.0.0.1:${await availablePort()}/v1`;
  const port = await availablePort();
  const env = {
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    ZVEC_GREP_API_KEY: "test-key",
    ZVEC_GREP_ENDPOINT: deadEndpoint,
    ZVEC_GREP_HOME: home,
    ZVEC_GREP_SERVER_URL: `http://127.0.0.1:${port}/mcp`,
  };
  t.after(async () => {
    // Removal happens only after confirmed termination and listener release;
    // an unconfirmed teardown throws and the directories remain as evidence.
    await ownedTeardown({ home, root, env, port });
    await removeTemporaryDirectory(temporaryDirectory);
  });
  let problems = null;
  let warmupThrew = null;
  try {
    ({ problems } = await runHealthProbe({
      root,
      home,
      env,
      port,
      measureDaemonGap: false,
    }));
  } catch (error) {
    warmupThrew = error;
  }
  if (warmupThrew) {
    // With a broken embedding endpoint the warmup index of the target store
    // fails and propagates — itself a detected workload failure.
    assert.match(
      String(warmupThrew.message ?? warmupThrew),
      /Command failed|warmup index .* failed|REQUEST_FAILED/,
    );
  } else {
    assert.ok(
      problems.length > 0,
      "probe unexpectedly passed with a failed workload",
    );
    assert.ok(
      /indexing did not succeed/.test(problems.join("; ")),
      JSON.stringify(problems),
    );
  }
  await ownedTeardown({ home, root, env, port });
  await removeTemporaryDirectory(temporaryDirectory);
});

test("teardown preserves ownership evidence when termination is unconfirmed", async (t) => {
  const temporaryDirectory = await createTemporaryDirectory(
    t,
    "zvec-grep-teardown-preserve-",
    {
      cleanup: false,
    },
  );
  const home = join(temporaryDirectory, "home");
  await mkdir(join(home, "daemon"), { recursive: true });
  const port = await availablePort();
  // A fabricated live daemon record: termination can never be confirmed, so
  // the teardown must throw and must NOT have removed the record or home.
  const fakePid = process.pid;
  await writeFile(
    join(home, "daemon", "instance.lock"),
    `${JSON.stringify({ pid: fakePid, serverUrl: `http://127.0.0.1:${port}` })}\n`,
  );
  let threw = null;
  try {
    await ownedTeardown({
      home,
      root: temporaryDirectory,
      env: process.env,
      port,
    });
  } catch (error) {
    threw = error;
  }
  assert.ok(threw, "teardown must throw when termination is unconfirmed");
  assert.match(threw.message, /teardown unconfirmed/);
  assert.match(threw.message, /preserved/);
  // Ownership evidence preserved: record and home still exist.
  const preserved = await readFile(
    join(home, "daemon", "instance.lock"),
    "utf8",
  );
  assert.match(preserved, new RegExp(`"pid":${fakePid}`));
});

test("teardown failure path preserves evidence with a live daemon", async (t) => {
  const temporaryDirectory = await createTemporaryDirectory(
    t,
    "zvec-grep-teardown-live-",
    { cleanup: false },
  );
  const root = temporaryDirectory;
  const home = join(temporaryDirectory, "home");
  await mkdir(join(home, "daemon"), { recursive: true });
  const port = await availablePort();
  const env = {
    ...process.env,
    ZVEC_GREP_HOME: home,
    HOME: home,
    NO_COLOR: "1",
  };
  const started = await runCli(
    ["--server", "on", "--listen", `127.0.0.1:${port}`, "--home", home],
    { cwd: root, env },
  );
  assert.match(started.stdout, /Server: ready/);
  const record = JSON.parse(
    await readFile(join(home, "daemon", "instance.lock"), "utf8"),
  );
  // Contained cleanup for the test itself: a correct stop that must succeed.
  t.after(async () => {
    await runCli(["--server", "off", "--home", home], { cwd: root, env }).catch(
      () => undefined,
    );
    try {
      process.kill(record.pid, "SIGKILL");
    } catch {
      // already gone
    }
    await removeTemporaryDirectory(temporaryDirectory);
  });
  // Sabotaged termination: the owning teardown is pointed at a home whose
  // record it cannot read and whose listener stays up, so termination is
  // unconfirmed; it must throw and preserve the real home's evidence.
  let threw = null;
  try {
    await ownedTeardown({
      home: join(temporaryDirectory, "elsewhere"),
      root,
      env,
      port,
    });
  } catch (error) {
    threw = error;
  }
  assert.ok(threw, "teardown must throw when termination is unconfirmed");
  assert.match(threw.message, /teardown unconfirmed/);
  let alive;
  try {
    process.kill(record.pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  assert.ok(alive, "daemon should still be alive in the failure path");
  const preserved = await readFile(
    join(home, "daemon", "instance.lock"),
    "utf8",
  );
  assert.match(preserved, new RegExp(`"pid":${record.pid}`));
});

test("query result assertion rejects zero-hit and wrong-file outputs", async () => {
  const expected = PROBE_FILE_NAME;
  const zeroHit = {
    code: 0,
    stdout:
      "query groups (1):\nQ1 [supplemental]: HealthProbeSymbol\nhits: 0\n",
  };
  let threw;
  try {
    const problems = queryResultProblems(zeroHit, expected);
    if (problems.length === 0)
      throw new Error("zero-hit output unexpectedly accepted");
    threw = problems;
  } catch (error) {
    threw = [String(error.message)];
  }
  assert.ok(
    threw.some((p) => /returned 0 hits/.test(p)),
    "expected the zero-hit failure at the hit-count assertion",
  );
  const wrongFile = {
    code: 0,
    stdout:
      "query groups (1):\nhits: 1\n#1 matchedBy=fts src/other.ts:1-2\nexport const HealthProbeSymbol = 42;\n",
  };
  const wrongFileProblems = queryResultProblems(wrongFile, expected);
  assert.ok(
    wrongFileProblems.some((p) => /not among matched entries/.test(p)),
    "expected the wrong-file failure at the file assertion",
  );
  const good = {
    code: 0,
    stdout: `query groups (1):\nhits: 1\n#1 matchedBy=fts some/dir/${expected}:1-2\nexport const HealthProbeSymbol = 42;\n`,
  };
  assert.deepEqual(queryResultProblems(good, expected), []);
});

test("probe CLI timeouts scale for slow and instrumented runners", () => {
  const base = 120_000;
  assert.ok(
    probeCliTimeoutMs(base, {}) > base,
    "baseline must give slow runners headroom beyond the reference cap",
  );
  assert.ok(
    probeCliTimeoutMs(base, {}) <= base * 2,
    "baseline scaling stays bounded",
  );
  assert.equal(
    probeCliTimeoutMs(base, { NODE_V8_COVERAGE: "/tmp/coverage" }),
    base * 3,
    "active V8 coverage must triple the cap (c8 run 36587089439)",
  );
  assert.equal(
    probeCliTimeoutMs(base, {}),
    probeCliTimeoutMs(base, { OTHER: "1" }),
    "only NODE_V8_COVERAGE triggers instrumented scaling",
  );
});

test("load window classification uses request start time", () => {
  const loadStartedAt = 1_000;
  assert.equal(
    inLoadWindow(1_000, loadStartedAt),
    true,
    "a request starting exactly at load start is in the window",
  );
  assert.equal(
    inLoadWindow(999, loadStartedAt),
    false,
    "a request starting before load stays outside the window even if it completes during it",
  );
  assert.equal(
    inLoadWindow(5_000, loadStartedAt),
    true,
    "later requests are in the window",
  );
  assert.equal(
    inLoadWindow(5_000, 0),
    false,
    "before load starts there is no window",
  );
});

test("health telemetry contract reports and resets the daemon event-loop gap", async (t) => {
  const temporaryDirectory = await createTemporaryDirectory(
    t,
    "zvec-grep-health-telemetry-",
    {
      cleanup: false,
    },
  );
  const root = join(temporaryDirectory, "repo");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "a.ts"), "export const TelemetrySymbol = 1;\n");
  const home = join(temporaryDirectory, "home");
  const endpoint = await createFakeEmbeddingServer(t);
  const port = await availablePort();
  const env = {
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    ZVEC_GREP_API_KEY: "test-key",
    ZVEC_GREP_ENDPOINT: endpoint,
    ZVEC_GREP_HOME: home,
    ZVEC_GREP_SERVER_URL: `http://127.0.0.1:${port}/mcp`,
  };
  t.after(async () => {
    await ownedTeardown({ home, root, env, port });
    await removeTemporaryDirectory(temporaryDirectory);
  });
  await mkdir(join(home, ".zvec-grep"), { recursive: true });
  await writeFile(
    join(home, ".zvec-grep", "config.json"),
    `${JSON.stringify({
      version: 1,
      defaults: { embedding: "qwen/text-embedding-v4" },
    })}\n`,
  );
  const started = await runCli(
    ["--server", "on", "--listen", `127.0.0.1:${port}`, "--home", home],
    { cwd: root, env },
  );
  assert.match(started.stdout, /Server: ready/);

  const read = async (reset) => {
    const response = await fetch(
      reset
        ? `http://127.0.0.1:${port}/healthz?resetLoopGap=1`
        : `http://127.0.0.1:${port}/healthz`,
      { signal: AbortSignal.timeout(2_000) },
    );
    assert.equal(response.status, 200);
    return parseHealthGap(await response.json());
  };
  const initial = await read(false);
  assert.ok(initial >= 0, "the reported gap starts non-negative");

  // Establish a NONZERO maximum first, so a reset that does nothing cannot
  // satisfy the assertions below: the first index of the target store blocks
  // the daemon's loop (store open plus model preparation — reproducibly
  // several hundred milliseconds on the reference hardware).
  const indexed = await runCli(
    ["--index", "--mode", "server", "--allow-remote", root],
    { cwd: root, env, timeout: probeCliTimeoutMs(120_000) },
  );
  assert.match(
    String(indexed.stdout),
    /Workspace index: succeeded/,
    "the contract workload (first index) must succeed",
  );
  const worked = await read(false);
  assert.ok(
    worked > 50,
    `the first-index workload must produce a measurable daemon gap, got ${worked}ms`,
  );

  const afterReset = await read(true);
  assert.ok(
    afterReset < worked,
    `reset must strictly reduce the reported maximum (${afterReset}ms after reset vs ${worked}ms before)`,
  );
  assert.ok(
    afterReset < 100,
    `a reset following real work reports a small gap, got ${afterReset}ms`,
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  const idle = await read(false);
  assert.ok(
    idle < 100,
    `an idle daemon keeps its reported gap small, got ${idle}ms`,
  );
});

test("load sample collector preserves late outliers beyond the buffer", () => {
  const collector = createLoadSampleCollector(40);
  // Fill the ordinary buffer with qualifying samples.
  for (let i = 0; i < 40; i++) {
    collector.observe(i * 10, 55, 60);
  }
  // More ordinary samples after the buffer is full — droppable.
  for (let i = 0; i < 40; i++) {
    collector.observe(10_000 + i * 10, 52, 61);
  }
  // The decisive outlier arrives LAST: the worst external observation, and a
  // new daemon-gap maximum, long after the buffer filled.
  collector.observe(50_000, 150, 90);

  const entries = collector.entries();
  const worst = entries.find((entry) => entry.t === 50_000);
  assert.ok(
    worst && worst.ext === 150 && worst.gap === 90,
    `the late worst-external observation must be retained, got ${JSON.stringify(worst)}`,
  );
  const firstGapMax = entries.find((entry) => entry.t === 0);
  assert.ok(
    firstGapMax && firstGapMax.gap === 60,
    "each new daemon-gap maximum is retained with its timestamp",
  );
  const lastOrdinaryBeforeOutlier = entries.some((entry) => entry.t === 10_390);
  assert.equal(
    lastOrdinaryBeforeOutlier,
    false,
    "ordinary samples past the buffer are droppable — only decisive ones are not",
  );
});

test("health gap parsing rejects invalid envelopes and malformed values", () => {
  assert.equal(
    parseHealthGap({ status: "ok" }),
    undefined,
    "a valid legacy envelope without telemetry means unknown",
  );
  assert.equal(
    parseHealthGap({ status: "ok", eventLoop: { maxGapMs: null } }),
    undefined,
  );
  assert.equal(
    parseHealthGap({ status: "ok", eventLoop: { maxGapMs: 42 } }),
    42,
  );
  assert.throws(() => parseHealthGap([]), /not a valid envelope/);
  assert.throws(
    () => parseHealthGap({ status: "error" }),
    /not a valid envelope/,
  );
  assert.throws(
    () => parseHealthGap({ status: "ok", eventLoop: { maxGapMs: -1 } }),
    /malformed/,
  );
  assert.throws(
    () => parseHealthGap({ status: "ok", eventLoop: { maxGapMs: Number.NaN } }),
    /malformed/,
  );
  assert.throws(
    () => parseHealthGap({ status: "ok", eventLoop: { maxGapMs: "87" } }),
    /malformed/,
  );
});
