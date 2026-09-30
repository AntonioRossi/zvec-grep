import assert from "node:assert/strict";
import test from "node:test";
import { startEventLoopMonitor } from "../../dist/daemon/event-loop-monitor.js";

test("event-loop monitor reports synthetic blocks and stays quiet at rest", async () => {
  const monitor = startEventLoopMonitor();

  // A quiet window: the sampler ticks on an idle loop; the reported gap
  // must stay small (scheduling slack only).
  await new Promise((resolve) => setTimeout(resolve, 350));
  const restGap = monitor.maxGapMs();
  assert.ok(restGap <= 60, `expected a small at-rest gap, got ${restGap}ms`);

  // A synchronous block of the event loop must be reported as a gap.
  const blockStart = performance.now();
  while (performance.now() - blockStart < 250) {
    // busy-wait: no timer can fire until this loop exits
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  const blockedGap = monitor.maxGapMs();
  assert.ok(
    blockedGap >= 150,
    `expected the synthetic 250ms block to be reported, got ${blockedGap}ms`,
  );

  monitor.stop();
});

test("event-loop monitor reset clears the reported maximum", async () => {
  const monitor = startEventLoopMonitor();
  const blockStart = performance.now();
  while (performance.now() - blockStart < 250) {
    // busy-wait: no timer can fire until this loop exits
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(monitor.maxGapMs() >= 150, "block must be reported before reset");

  monitor.resetMax();
  await new Promise((resolve) => setTimeout(resolve, 350));
  const afterReset = monitor.maxGapMs();
  assert.ok(
    afterReset <= 60,
    `expected the reset maximum to stay small at rest, got ${afterReset}ms`,
  );

  monitor.stop();
});
