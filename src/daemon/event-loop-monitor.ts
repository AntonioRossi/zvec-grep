/**
 * Tracks the daemon's own event-loop responsiveness so health observers can
 * distinguish daemon-side blocking from observer-side scheduling noise on
 * shared runners. In CI run 36587089439 (Windows, 2026-09-29) an external
 * 599ms health latency could not be attributed to either cause; this
 * sampler is the daemon-side half of that discrimination.
 *
 * The sampler timer only fires when the event loop turns, so
 * `now - previousTick - SAMPLE_INTERVAL_MS` is the time the daemon spent
 * blocked in synchronous work or descheduled since the previous tick. The
 * daemon exposes the cumulative maximum on `/healthz`; an observer compares
 * it against external request latency: a large gap indicts the daemon side,
 * a large external latency with a small gap indicts the observer.
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
