import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
      const address = server.address();
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

test("daemon /healthz stays responsive under overlapping scanner and search load", async (t) => {
  const temporaryDirectory = await createTemporaryDirectory(
    t,
    "zvec-grep-health-probe-",
  );
  const root = join(temporaryDirectory, "repo");
  const home = join(temporaryDirectory, "home");

  // Heavy admitted scanner fixture (the proven latency shape): 100 rules of
  // '*a'x100 + '*Z' + i, eight nested 200-character directories, and a
  // 204-character filename.
  let dir = root;
  for (let depth = 0; depth < 8; depth++) {
    dir = join(dir, "a".repeat(200));
    await mkdir(dir, { recursive: true });
  }
  const fileName = `f${"g".repeat(201)}.ts`;
  await writeFile(
    join(dir, fileName),
    "export const HealthProbeSymbol = 42;\n",
  );
  const rules = Array.from(
    { length: 100 },
    (_, i) => "*a".repeat(100) + "*Z" + i,
  );
  await writeFile(join(root, ".gitignore"), `${rules.join("\n")}\n`);

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
  await mkdir(join(home, ".zvec-grep"), { recursive: true });
  await writeFile(
    join(home, ".zvec-grep", "config.json"),
    `${JSON.stringify({
      version: 1,
      defaults: { embedding: "qwen/text-embedding-v4" },
    })}\n`,
  );

  const stopPolling = async () => {
    await runCli(["--server", "off", "--home", home], {
      cwd: root,
      env,
    }).catch(() => undefined);
    await rm(join(home, ".zvec-grep", "instance.lock"), {
      force: true,
    }).catch(() => undefined);
  };
  t.after(async () => {
    await stopPolling();
    await removeTemporaryDirectory(temporaryDirectory);
  });

  await runCli(
    ["--server", "on", "--listen", `127.0.0.1:${port}`, "--home", home],
    {
      cwd: root,
      env,
    },
  );

  // Independent polling: this process's event loop is not the daemon's.
  let polling = true;
  let worstHealthMs = 0;
  let polls = 0;
  const t0 = Date.now();
  const healthUrl = `http://127.0.0.1:${port}/healthz`;
  const pollLoop = (async () => {
    while (polling) {
      const started = Date.now();
      const response = await fetch(healthUrl).catch(() => null);
      const elapsed = Date.now() - started;
      polls++;
      if (response) {
        assert.equal(response.status, 200);
        // Warmup (daemon boot, module and model preparation) is excluded;
        // the assertion bounds steady-state responsiveness under load.
        if (Date.now() - t0 > 2_000) {
          worstHealthMs = Math.max(worstHealthMs, elapsed);
        }
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
    }
  })();

  // Overlapping load: the daemon indexes the heavy repository (scanner and
  // embedding) while also serving a server-mode query (search filters).
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

  assert.match(
    String(indexed.stdout ?? indexed.stderr ?? ""),
    /succeeded|Indexing complete|Scanning/,
  );
  assert.ok(polls > 10, `expected sustained polling, got ${polls} polls`);
  assert.ok(
    worstHealthMs < 400,
    `worst steady-state /healthz latency was ${worstHealthMs}ms across ${polls} polls (warmup excluded)`,
  );
  assert.ok(
    !queried?.code,
    `server query failed: ${queried?.stderr ?? queried}`,
  );
  await stopPolling();
});
