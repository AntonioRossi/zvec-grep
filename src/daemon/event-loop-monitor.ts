/**
 * Tracks the daemon's own event-loop responsiveness so health observers
 * have daemon-side evidence for latency attribution. In CI run 36587089439
 * (Windows, 2026-09-29) an external 599ms health latency could not be
 * attributed to any cause; this sampler is the daemon-side half of that
 * evidence.
 *
 * The sampler timer only fires when the event loop turns, so
 * `now - previousTick - SAMPLE_INTERVAL_MS` is the time the daemon spent
 * blocked in synchronous work OR descheduled since the previous tick — the
 * metric does not separate the two. The daemon exposes the cumulative
 * maximum on `/healthz`; an observer correlates it with external request
 * latency as SUPPORTING EVIDENCE only. A large gap shows the daemon side
 * was stalled (blocking or descheduling); it does not establish
 * synchronous application blocking, and a small gap with large external
 * latency does not by itself blame the observer — sampling coverage and
 * request timing also matter. Application blocking, daemon descheduling
 * and observer delay stay unresolved unless the collected evidence
 * separates them.
 */
const SAMPLE_INTERVAL_MS = 100;

export type EventLoopMonitor = {
  /** Cumulative maximum event-loop gap in milliseconds since start. */
  readonly maxGapMs: () => number;
  /** Zero the reported maximum; gaps before the next tick are forgotten. */
  readonly resetMax: () => void;
  readonly stop: () => void;
};

export function startEventLoopMonitor(): EventLoopMonitor {
  let lastTick = performance.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    const gap = now - lastTick - SAMPLE_INTERVAL_MS;
    if (gap > maxGap) {
      maxGap = gap;
    }
    lastTick = now;
  }, SAMPLE_INTERVAL_MS);
  timer.unref();
  return {
    maxGapMs: () => Math.max(0, Math.round(maxGap)),
    resetMax: () => {
      maxGap = 0;
      // Advance the sampling epoch too: a tick that is already overdue when
      // the reset lands must not import pre-reset delay into the new window.
      lastTick = performance.now();
    },
    stop: () => clearInterval(timer),
  };
}
