import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createTemporaryDirectory,
  removeTemporaryDirectory,
  runCli,
} from "./helpers/fixtures.mjs";
import { createFakeEmbeddingServer } from "./helpers/fake-embedding.mjs";

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
    dir = join(dir, "a".repeat(200));
    await mkdir(dir, { recursive: true });
  }
  await writeFile(
    join(dir, `f${"g".repeat(201)}.ts`),
    "export const HealthProbeSymbol = 42;\n",
  );
  const rules = Array.from(
    { length: 100 },
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
  let worstHealthMs = 0;
  let okPolls = 0;
  const failures = [];
  const t0 = Date.now();
  const healthUrl_ = healthUrl ?? `http://127.0.0.1:${port}/healthz`;
  const pollLoop = (async () => {
    while (polling) {
      const requestStart = Date.now();
      try {
        const response = await fetch(healthUrl_);
        const elapsed = Date.now() - requestStart;
        if (response.status !== 200) {
          failures.push(`status ${response.status}`);
        } else {
          okPolls++;
          if (Date.now() - t0 > 2_000) {
            worstHealthMs = Math.max(worstHealthMs, elapsed);
          }
        }
      } catch (error) {
        failures.push(String(error?.cause?.code ?? error?.message ?? error));
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
    }
  })();

  const queryArgs = [
    "--fts",
    "HealthProbeSymbol",
    "--limit",
    "1",
    "--refresh",
    "off",
    "--allow-remote",
  ];
  const [indexed, queried] = await Promise.all([
    runCli(["--index", "--mode", "server", "--allow-remote", root], {
      cwd: root,
      env,
      timeout: 180_000,
    }).catch((error) => error),
    (async () => {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
      return runCli([...queryArgs, "--mode", "server"], {
        cwd: root,
        env,
        timeout: 120_000,
      }).catch((error) => error);
    })(),
  ]);
  polling = false;
  await pollLoop;

  const problems = [];
  if (failures.length > 0) {
    problems.push(`${failures.length} health requests failed (${failures[0]})`);
  }
  if (okPolls < minOkPolls) {
    problems.push(`only ${okPolls} successful health responses`);
  }
  if (worstHealthMs >= maxMs) {
    problems.push(`worst steady-state health latency ${worstHealthMs}ms`);
  }
  const indexedOk =
    !indexed?.code &&
    /Workspace index: succeeded/.test(String(indexed.stdout ?? ""));
  const queriedOk =
    !queried?.code && /HealthProbeSymbol/.test(String(queried.stdout ?? ""));
  if (expectWorkloadSuccess) {
    if (!indexedOk)
      problems.push(
        `indexing did not succeed: ${String(indexed?.stderr ?? indexed)}`.slice(
          0,
          200,
        ),
      );
    if (!queriedOk)
      problems.push(
        `query did not find the symbol: ${String(queried?.stderr ?? queried)}`.slice(
          0,
          200,
        ),
      );
  }
  return { problems, worstHealthMs, okPolls };
}

async function teardownDaemon(home, root, env) {
  await runCli(["--server", "off", "--home", home], { cwd: root, env }).catch(
    () => undefined,
  );
}

test("daemon /healthz stays responsive under overlapping load", async (t) => {
  const temporaryDirectory = await createTemporaryDirectory(
    t,
    "zvec-grep-health-probe-",
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
    await teardownDaemon(home, root, env);
    await removeTemporaryDirectory(temporaryDirectory);
  });

  const { problems, worstHealthMs, okPolls } = await runHealthProbe({
    root,
    home,
    env,
    port,
  });
  assert.deepEqual(problems, []);
  assert.ok(okPolls >= 50, `expected sustained polling, got ${okPolls}`);
  assert.ok(
    worstHealthMs < 400,
    `worst steady-state latency ${worstHealthMs}ms`,
  );
  await teardownDaemon(home, root, env);
});

test("health probe negative control: unavailable health fails the probe", async (t) => {
  const temporaryDirectory = await createTemporaryDirectory(
    t,
    "zvec-grep-health-dead-",
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
    await teardownDaemon(home, root, env);
    await removeTemporaryDirectory(temporaryDirectory);
  });
  // Polling a port with no listener: the probe must report failure even
  // though the daemon itself and its workload are healthy.
  const { problems } = await runHealthProbe({
    root,
    home,
    env,
    port,
    healthUrl: `http://127.0.0.1:${deadPort}/healthz`,
  });
  assert.ok(
    problems.length > 0,
    "probe unexpectedly passed with no health listener",
  );
  assert.ok(
    problems.some((p) => /health requests failed|successful health/.test(p)),
    JSON.stringify(problems),
  );
  await teardownDaemon(home, root, env);
});

test("health probe negative control: failed workload fails the probe", async (t) => {
  const temporaryDirectory = await createTemporaryDirectory(
    t,
    "zvec-grep-health-broken-",
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
    await teardownDaemon(home, root, env);
    await removeTemporaryDirectory(temporaryDirectory);
  });
  const { problems } = await runHealthProbe({ root, home, env, port });
  assert.ok(
    problems.length > 0,
    "probe unexpectedly passed with a failed workload",
  );
  assert.ok(
    /indexing did not succeed/.test(problems.join("; ")),
    JSON.stringify(problems),
  );
  await teardownDaemon(home, root, env);
});
