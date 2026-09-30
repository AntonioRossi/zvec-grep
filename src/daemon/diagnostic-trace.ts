/**
 * Diagnostic-only event trace (round 28, §10 investigation). Distinct from
 * the cumulative-gap monitor: this records individual timestamped events —
 * sampler ticks with their interval overshoot, and per-request handler
 * spans — in a bounded ring buffer with an explicit dropped-event counter.
 * Correlation is by overlapping time intervals; cumulative maxima are never
 * subtracted, and missing samples never imply "no delay". Diagnostic branch
 * only: never part of the submission.
 */
const TRACE_CAPACITY = 4096;
const IN_FLIGHT_CAPACITY = 1024;

export type TraceEvent =
  | { kind: "tick"; t: number; overshootMs: number }
  | { kind: "handler"; id: number; start: number; end: number; path: string };

export type DiagnosticTrace = {
  record: (event: TraceEvent) => void;
  lastTick: () => number;
  setLastTick: (t: number) => void;
  requestStarted: (id: number, path: string) => void;
  requestFinished: (id: number) => void;
  inFlightSnapshot: () => number[];
  dropped: () => number;
  events: () => TraceEvent[];
  start: () => number;
};

export function createDiagnosticTrace(): DiagnosticTrace {
  const buffer: TraceEvent[] = [];
  let droppedCount = 0;
  const inFlight = new Set<number>();
  let inFlightDropped = 0;
  const start = performance.now();
  let tickMark = start;
  const record = (event: TraceEvent) => {
    if (buffer.length >= TRACE_CAPACITY) {
      droppedCount += 1;
      return;
    }
    buffer.push(event);
  };
  return {
    record,
    lastTick: () => tickMark,
    setLastTick: (t) => {
      tickMark = t;
    },
    requestStarted: (id, path) => {
      if (inFlight.size >= IN_FLIGHT_CAPACITY) {
        inFlightDropped += 1;
        droppedCount += 1;
        return;
      }
      inFlight.add(id);
      record({ kind: "handler", id, start: performance.now(), end: 0, path });
    },
    requestFinished: (id) => {
      inFlight.delete(id);
      const open = buffer.find(
        (e) => e.kind === "handler" && e.id === id && e.end === 0,
      );
      if (open && open.kind === "handler") {
        open.end = performance.now();
      } else {
        droppedCount += 1;
      }
    },
    inFlightSnapshot: () => [...inFlight],
    dropped: () => droppedCount + inFlightDropped,
    events: () => [...buffer],
    start: () => start,
  };
}
