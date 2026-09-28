import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { inWorker } from "../helpers/glob-worker.mjs";
import * as glob from "../../dist/engine/utils/glob.js";
import { createTemporaryDirectory } from "../helpers/fixtures.mjs";

test("glob matching preserves wildcard, directory, class, and brace semantics", () => {
  const cases = [
    ["*.ts", "src/main.ts", true],
    ["*.ts", "src/main.js", false],
    ["src/*.ts", "src/nested/main.ts", false],
    ["src/**/main.ts", "src/main.ts", true],
    ["src/**/main.ts", "src/a/b/main.ts", true],
    ["src/**", "src", true],
    ["src/**", "src/a/b", true],
    ["*.{js,ts}", "src/main.ts", true],
    ["{a,{b,c}}.ts", "c.ts", true],
    ["{,a}b", "b", true],
    ["{a,}b", "ab", true],
    ["file[0-9].ts", "file2.ts", true],
    ["file[!0-9].ts", "filex.ts", true],
    ["file[^0-9].ts", "file2.ts", false],
    ["[[]", "[", true],
    ["a[", "a[", true],
    ["a{b}", "a{b}", true],
    ["a[]", "a[]", true],
    ["a[!]", "a[!]", true],
    ["a[^]", "a[^]", true],
    ["??", "😀", true],
    ["?", "😀", false],
    ["**Z", "a\nZ", false],
    ["*Z", "a\nZ", true],
  ];
  for (const [pattern, path, expected] of cases) {
    assert.equal(
      glob.ripgrepGlobMatches(pattern, path),
      expected,
      JSON.stringify([pattern, path]),
    );
  }
  assert.throws(() => glob.ripgrepGlobMatches("[z-a]", "a"), SyntaxError);
  assert.equal(glob.ripgrepGlobMatches("", "a"), false);
});

test("glob helpers retain literal-path and case normalization behavior", () => {
  assert.equal(glob.pathPatternMatches("src", "src/main.ts"), true);
  assert.equal(glob.ripgrepGlobMatches("src", "src/main.ts"), false);
  assert.equal(glob.pathPatternMatches("{a,b}", "a"), false);
  assert.equal(glob.pathPatternMatches(" ./src//*.ts ", "src\\main.ts"), true);
  assert.equal(glob.pathPatternMatches("/src/*.ts", "/src/main.ts"), true);
  assert.equal(
    glob.pathPatternMatches("C:\\src\\*.ts", "C:/src/main.ts"),
    true,
  );
  assert.equal(glob.pathPatternMatches("", "src"), false);
  assert.equal(
    glob.pathPatternMatchesCaseInsensitive("SRC", "src/main.ts"),
    true,
  );
  assert.equal(
    glob.pathPatternMatchesCaseInsensitive("*.TS", "src/main.ts"),
    true,
  );
  assert.equal(
    glob.ripgrepGlobMatchesCaseInsensitive("[A-Z]*.TS", "main.ts"),
    true,
  );
  assert.equal(glob.ripgrepGlobMatchesCaseInsensitive("É*", "éclair"), true);
  assert.equal(glob.ripgrepGlobMatchesCaseInsensitive("K*", "Kelvin"), false);
  assert.equal(glob.ripgrepGlobMatchesCaseInsensitive("S*", "ſ"), false);
  assert.equal(glob.ripgrepGlobMatches("*.TS", "main.ts"), false);
  assert.equal(glob.pathPatternMightMatchDescendant("src/*.ts", "src"), true);
  assert.equal(glob.pathPatternMightMatchDescendant("src/**", "docs"), false);
});

test("adversarial wildcard and alternation matching completes without backtracking", async () => {
  await inWorker(`
    for (const pattern of ['**'.repeat(20) + 'Z', '*a'.repeat(20) + 'Z', '**/' + '{a,aa}'.repeat(20) + 'Z']) {
      for (const fn of [glob.pathPatternMatches, glob.pathPatternMatchesCaseInsensitive, glob.ripgrepGlobMatches, glob.ripgrepGlobMatchesCaseInsensitive]) {
        assert.equal(fn(pattern, 'a'.repeat(40)), false);
        assert.equal(fn(pattern, 'a'.repeat(40) + 'Z'), true);
      }
    }
    assert.equal(glob.ripgrepGlobMatches('**'.repeat(20) + 'Z', 'src/authorization/operation.ts'), false);
  `);
});

test("scanner and MCP filters accept the regression pattern without stalling", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-glob-regression-");
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "src", "operation.ts"),
    "export const answer = 1;\n",
  );
  await writeFile(join(root, ".gitignore"), `${"**".repeat(20)}Z\n`);
  await inWorker(
    `
    const pattern = '**'.repeat(20) + 'Z';
    zvecGrepSearchInputSchema.parse({ root: workerData, fts: 'answer', globs: [pattern] });
    assert.equal((await scanRootPaths('glob-test', [{ absolutePath: workerData, recursive: true }])).files.length, 1);
    assert.equal((await scanRootPaths('glob-test', [{ absolutePath: workerData, recursive: true, globs: [pattern] }])).files.length, 0);
  `,
    root,
  );
});

test("glob complexity limits reject expensive inputs without hanging", async () => {
  await inWorker(
    `
    assert.throws(() => glob.ripgrepGlobMatches('*'.repeat(4097), 'a'), /4096-character/);
    assert.throws(() => glob.ripgrepGlobMatches('*', 'a'.repeat(32769)), /32768-character/);
    assert.throws(() => glob.ripgrepGlobMatches('{a,'.repeat(33) + 'b' + '}'.repeat(33), 'a'), /nesting limit/);
    assert.throws(() => glob.ripgrepGlobMatches('*a'.repeat(1000) + 'Z', 'a'.repeat(4096)), /matching work limit/);
    // The operation-wide pool is gone: cumulative legitimate matching no longer
    // rejects an operation; a single expensive match still hits its per-match
    // cap, and per-path accounting bounds rule sets per candidate.
    withGlobBudget(() => {
      for (let i = 0; i < 3000; i++) glob.ripgrepGlobMatches('**', 'a'.repeat(8192));
    });
    // A failed operation must not poison the next one, including cached matchers.
    assert.equal(withGlobBudget(() => glob.ripgrepGlobMatches('**', 'a')), true);
  `,
    undefined,
    10_000,
  );
});

test("invalid and oversized ignore files fail with source context rather than bypassing ignores", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-glob-limits-");
  await writeFile(join(root, "secret.ts"), "export const secret = 1;\n");
  await inWorker(
    `
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const ignore = join(workerData, '.gitignore');
    const scan = () => scanRootPaths('glob-limits', [{ absolutePath: workerData, recursive: true }]);
    await writeFile(ignore, '# comment\\n[z-a]\\n');
    await assert.rejects(scan(), /\\.gitignore:2:/);
    await writeFile(ignore, '*'.repeat(4097));
    await assert.rejects(scan(), /\\.gitignore:1:.*4096-character/);
    await writeFile(ignore, '#'.repeat(1048577));
    await assert.rejects(scan(), /1048576-byte.*\\.gitignore/);
    await writeFile(ignore, 'secret.ts\\n'.repeat(10001));
    await assert.rejects(scan(), /10000-rule/);
    await writeFile(ignore, 'secret.ts\\n');
    assert.equal((await scan()).files.length, 0);
    await writeFile(ignore, '');
    assert.equal((await scan()).files.length, 1);
  `,
    root,
  );
});

test("per-path accounting admits ordinary large repositories without custom filters", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-glob-large-");
  await inWorker(
    `
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(workerData, 'packages/service/src/modules/authentication/handlers');
    await mkdir(dir, { recursive: true });
    const batch = [];
    for (let i = 0; i < 15000; i++) {
      batch.push(writeFile(join(dir, 'file-' + String(i).padStart(8, '0') + '.ts'), 'export const a = 1;\\n'));
      if (batch.length === 256) {
        await Promise.all(batch);
        batch.length = 0;
      }
    }
    await Promise.all(batch);
    const result = await scanRootPaths('glob-large', [{ absolutePath: workerData, recursive: true }]);
    assert.equal(result.files.length, 15000);
  `,
    root,
    180_000,
  );
});

test("match-time work-limit failures identify the offending ignore rule and request glob", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-glob-attrib-");
  const longName = `f${"x".repeat(250)}.ts`;
  await writeFile(join(root, longName), "export const a = 1;\n");
  await inWorker(
    `
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const heavy = '*'.repeat(4094) + 'Z';
    const longName = ${JSON.stringify(longName)};
    const scan = (extra) => scanRootPaths('glob-attrib', [{ absolutePath: workerData, recursive: true, ...extra }]);
    await writeFile(join(workerData, '.gitignore'), heavy + '\\n');
    await assert.rejects(
      scan(),
      (error) => /work limit/.test(error.message) && /\\.gitignore:1/.test(error.message),
    );
    await writeFile(join(workerData, '.gitignore'), '');
    await assert.rejects(
      scan({ globs: [heavy] }),
      (error) => /work limit/.test(error.message) && /globs\\[0\\]/.test(error.message),
    );
    await assert.rejects(
      scan({ insensitiveGlobs: [heavy] }),
      (error) => /work limit/.test(error.message) && /insensitiveGlobs\\[0\\]/.test(error.message),
    );
  `,
    root,
    30_000,
  );
});

test("oversized active rule sets reject on every scanner route", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-glob-admission-");
  const heavy = "a".repeat(4090);
  const file = join(root, "f.ts");
  await writeFile(file, "export const a = 1;\n");
  await inWorker(
    `
    const include = Array.from({ length: 62 }, () => ${JSON.stringify(heavy)});
    const { scanFilePath, pathCanAffectIndex } = await import(${JSON.stringify(new URL("../../dist/engine/pipeline/indexing/scanner/index.js", import.meta.url).href)});
    await assert.rejects(
      () => scanRootPaths('adm', [{ absolutePath: workerData, recursive: true, include }]),
      /active-rule limit/,
    );
    await assert.rejects(
      () => scanRootPaths('adm', [{ absolutePath: ${JSON.stringify(file)}, recursive: false, include }]),
      /active-rule limit/,
    );
    await assert.rejects(
      () => scanFilePath('adm', [{ absolutePath: workerData, recursive: true, include }], ${JSON.stringify(file)}),
      /active-rule limit/,
    );
    await assert.rejects(
      () => pathCanAffectIndex([{ absolutePath: workerData, recursive: true, include }], ${JSON.stringify(file)}, false),
      /active-rule limit/,
    );
  `,
    root,
    60_000,
  );
});

test("scanner loading does not debit the matching pool", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-glob-load-");
  await inWorker(
    `
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const comment = '#'.repeat(1_000_000) + '\\n';
    let dir = workerData;
    for (let i = 0; i < 101; i++) {
      dir = join(dir, 'd' + i);
      await mkdir(dir);
      await writeFile(join(dir, '.gitignore'), comment);
    }
    await writeFile(join(dir, 'file.ts'), 'export const a = 1;\\n');
    const result = await scanRootPaths('glob-load', [{ absolutePath: workerData, recursive: true }]);
    assert.equal(result.files.length, 1);
  `,
    root,
    240_000,
  );
});

test("built-in fast paths keep exact ignore semantics for literal and suffix rules", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-glob-fastpath-");
  const dirs = ["node_modules", "build", "not-node_modules", "distx"];
  const files = [
    "a.lock",
    "b.lockb",
    "c-lock.json",
    "d.map",
    "e.min.js",
    "f.mjs",
    "g.generated.ts",
    "h.po",
    "keep.ts",
    "node_modules.txt",
  ];
  for (const dir of dirs) await mkdir(join(root, dir), { recursive: true });
  for (const name of files) await writeFile(join(root, name), "x");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.ts"), "x");
  await inWorker(
    `
    const result = await scanRootPaths('glob-fastpath', [{ absolutePath: workerData, recursive: true }]);
    const kept = result.files.map((f) => f.relativePath).sort();
    assert.deepEqual(kept, ['f.mjs', 'keep.ts', 'node_modules.txt', 'src/main.ts']);
  `,
    root,
    30_000,
  );
});

test("100000 realistic-depth candidates pass through the per-path accounting", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-glob-scale-");
  await inWorker(
    `
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    let dir = workerData;
    for (let depth = 0; depth < 6; depth++) {
      dir = join(dir, 'svc' + depth);
      await mkdir(dir);
      await writeFile(join(dir, '.gitignore'), 'debug/\\n*.tmp\\n');
      await mkdir(join(dir, 'debug'));
      await writeFile(join(dir, 'debug', 'skip.ts'), 'x');
    }
    const batch = [];
    let created = 0;
    for (let i = 0; i < 100000; i++) {
      const file = join(dir, 'f' + String(i).padStart(6, '0') + '.ts');
      batch.push(writeFile(file, 'export const a = 1;\\n'));
      created++;
      if (batch.length === 512) {
        await Promise.all(batch);
        batch.length = 0;
      }
    }
    await Promise.all(batch);
    const result = await scanRootPaths('glob-scale', [{ absolutePath: workerData, recursive: true }]);
    assert.equal(result.files.length, created);
  `,
    root,
    600_000,
  );
});

test("concurrent scans keep independent budgets and recover after a failure", async (t) => {
  const left = await createTemporaryDirectory(t, "zvec-glob-conc-a-");
  const right = await createTemporaryDirectory(t, "zvec-glob-conc-b-");
  await writeFile(join(left, "a.ts"), "x");
  await writeFile(join(right, "b.ts"), "x");
  await inWorker(
    `
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const [leftResult, rightResult] = await Promise.all([
      scanRootPaths('conc', [{ absolutePath: ${JSON.stringify(left)}, recursive: true }]),
      scanRootPaths('conc', [{ absolutePath: ${JSON.stringify(right)}, recursive: true }]),
    ]);
    assert.equal(leftResult.files.length, 1);
    assert.equal(rightResult.files.length, 1);
    const heavy = '*'.repeat(4094) + 'Z';
    await writeFile(join(${JSON.stringify(left)}, 'f' + 'x'.repeat(250) + '.ts'), 'x');
    await writeFile(join(${JSON.stringify(left)}, '.gitignore'), heavy + '\\n');
    await assert.rejects(
      () => scanRootPaths('conc', [{ absolutePath: ${JSON.stringify(left)}, recursive: true }]),
      /\\.gitignore:1/,
    );
    const recovered = await scanRootPaths('conc', [{ absolutePath: ${JSON.stringify(right)}, recursive: true }]);
    assert.equal(recovered.files.length, 1);
  `,
    undefined,
    60_000,
  );
});

test("root include pattern work-limit failures carry their index", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-glob-rootinc-");
  const longName = `f${"x".repeat(250)}.ts`;
  await writeFile(join(root, longName), "x");
  await inWorker(
    `
    const heavy = '*'.repeat(4094) + 'Z';
    await assert.rejects(
      () => scanRootPaths('rootinc', [{ absolutePath: workerData, recursive: true, include: [heavy] }]),
      (error) => /work limit/.test(error.message) && /root include\\[0\\]/.test(error.message),
    );
    await assert.rejects(
      () => scanRootPaths('rootinc', [{ absolutePath: workerData, recursive: true, exclude: ['keep.ts', heavy] }]),
      (error) => /work limit/.test(error.message) && /root exclude\\[1\\]/.test(error.message),
    );
  `,
    root,
    30_000,
  );
});

test("brace alternation ignore rules and ordered negation survive the fast paths", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-glob-brace-");
  await mkdir(join(root, "pkg"), { recursive: true });
  for (const name of ["a.ts", "b.js", "keep.ts", "c.mjs", "pkg/inner.ts"]) {
    await writeFile(join(root, name), "x");
  }
  await writeFile(join(root, ".gitignore"), "*.{ts,js}\n!keep.ts\n");
  await inWorker(
    `
    const result = await scanRootPaths('glob-brace', [{ absolutePath: workerData, recursive: true }]);
    assert.deepEqual(result.files.map((f) => f.relativePath).sort(), ['c.mjs', 'keep.ts']);
  `,
    root,
    30_000,
  );
});

test("ripgrep-semantics literal globs are charged their compiled weight", async (t) => {
  const root = await createTemporaryDirectory(t, "zvec-glob-weight-");
  await writeFile(join(root, "f.ts"), "x");
  await inWorker(
    `
    const heavy = Array.from({ length: 128 }, () => 'a'.repeat(1002));
    await assert.rejects(
      () => scanRootPaths('glob-weight', [{ absolutePath: workerData, recursive: true, globs: heavy }]),
      /active-rule limit/,
    );
    const moderate = heavy.slice(0, 100);
    const result = await scanRootPaths('glob-weight', [{ absolutePath: workerData, recursive: true, globs: moderate }]);
    assert.equal(result.files.length, 0);
    const kept = await scanRootPaths('glob-weight', [{ absolutePath: workerData, recursive: true, fileTypes: ['ts'] }]);
    assert.deepEqual(kept.files.map((f) => f.relativePath), ['f.ts']);
  `,
    root,
    60_000,
  );
});

test("cancellation aborts a scan under load and overlapping failures spare healthy scans", async (t) => {
  const load = await createTemporaryDirectory(t, "zvec-glob-cancel-load-");
  const healthy = await createTemporaryDirectory(t, "zvec-glob-cancel-ok-");
  await writeFile(join(healthy, "ok.ts"), "x");
  await inWorker(
    `
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(workerData, 'bulk');
    await mkdir(dir);
    for (let i = 0; i < 4000; i++) {
      await writeFile(join(dir, 'f' + i + '.ts'), 'x');
    }
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(
      () => scanRootPaths('cancel', [{ absolutePath: workerData, recursive: true }], { signal: controller.signal }),
      /cancel|abort/i,
    );
    const heavy = Array.from({ length: 128 }, () => 'a'.repeat(1002));
    const healthyRoot = ${JSON.stringify(healthy)};
    const [failed, ok] = await Promise.allSettled([
      scanRootPaths('cancel', [{ absolutePath: workerData, recursive: true, globs: heavy }]),
      scanRootPaths('cancel', [{ absolutePath: healthyRoot, recursive: true }]),
    ]);
    assert.equal(failed.status, 'rejected');
    assert.equal(ok.status, 'fulfilled');
    assert.equal(ok.value.files.length, 1);
  `,
    load,
    120_000,
  );
});
