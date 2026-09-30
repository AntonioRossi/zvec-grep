import assert from "node:assert/strict";
import test from "node:test";
import { createDiagnosticTrace } from "../../dist/daemon/diagnostic-trace.js";

test("diagnostic trace records ticks and handler spans with dropped counts", () => {
  const trace = createDiagnosticTrace();
  trace.record({ kind: "tick", t: trace.start() + 100, overshootMs: 3 });
  trace.requestStarted(1, "/healthz");
  trace.requestFinished(1);
  trace.requestStarted(2, "/healthz");
  const inFlight = trace.inFlightSnapshot();
  assert.deepEqual(inFlight, [2]);
  trace.requestFinished(2);
  trace.requestFinished(999); // unknown id: counted as dropped
  const events = trace.events();
  assert.equal(events.filter((e) => e.kind === "tick").length, 1);
  const handlers = events.filter((e) => e.kind === "handler");
  assert.equal(handlers.length, 2);
  assert.ok(handlers.every((h) => h.end >= h.start));
  assert.equal(trace.dropped(), 1);
  assert.deepEqual(trace.inFlightSnapshot(), []);
});
