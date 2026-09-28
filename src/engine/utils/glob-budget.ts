import { AsyncLocalStorage } from "node:async_hooks";

export const MAX_GLOB_PATTERN_CHARS = 4_096;
export const MAX_GLOB_PATH_CHARS = 32_768;
export const MAX_GLOB_RULES = 10_000;
/**
 * Upper bound on the combined compiled weight of every rule that may be
 * applied to one candidate path: built-in ignores, ignore-file rules, root
 * include/exclude patterns, request globs and expanded file types. Unlike the
 * matcher cache bound, exceeding this rejects the rule set itself.
 */
export const MAX_ACTIVE_RULE_WEIGHT = 250_000;

/**
 * Fixed per-path headroom. Must stay above the matcher's one-million-work
 * per-match cap so a single admitted pattern can complete (or reject through
 * its own cap) without tripping the path budget first.
 */
const PATH_WORK_BASE = 1_500_000;
/**
 * Legitimate matching work for one path grows with the path length times the
 * compiled weight of the active rules; the bounded NFA keeps actual work at
 * or below that linear bound, so this multiplier leaves headroom and the
 * allowance acts as a safety net for accounting bugs rather than an
 * adversary-reachable cap. Expensive single matches reject through the
 * per-match cap; oversized rule sets reject at admission.
 */
const PATH_WORK_MULTIPLIER = 4;

export class GlobWorkLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobWorkLimitError";
  }
}

type GlobBudgetStore = {
  sinceYield: number;
  pathRemaining?: number;
  overheadOnly?: boolean;
};

const operationBudget = new AsyncLocalStorage<GlobBudgetStore>();

/** Keep concurrent searches/scans independent, and share a budget with nested work. */
export function withGlobBudget<T>(operation: () => T): T {
  if (operationBudget.getStore()) return operation();
  return operationBudget.run({ sinceYield: 0 }, operation);
}

export function globPathAllowance(
  pathLength: number,
  activeRuleWeight: number,
): number {
  return (
    PATH_WORK_BASE + (pathLength + 16) * activeRuleWeight * PATH_WORK_MULTIPLIER
  );
}

/**
 * Charge all rule checks for one candidate path against a shared allowance
 * sized by that path and the active rule weight. Nested calls restore the
 * enclosing path budget. Yield and cancellation accounting is unaffected.
 */
export function withGlobPathBudget<T>(
  pathLength: number,
  activeRuleWeight: number,
  body: () => T,
): T {
  const allowance = globPathAllowance(pathLength, activeRuleWeight);
  const store = operationBudget.getStore();
  if (!store) {
    return operationBudget.run(
      { sinceYield: 0, pathRemaining: allowance },
      body,
    );
  }
  const previous = store.pathRemaining;
  store.pathRemaining = allowance;
  try {
    return body();
  } finally {
    store.pathRemaining = previous;
  }
}

/**
 * Loading and compilation work (ignore-file reads, parse-time normalization
 * and validation, matcher compilation): counted for cooperative yielding
 * only, never debited from the operation pool or a path allowance. Bounded
 * by the per-input limits and active-rule admission instead.
 */
export function chargeGlobOverhead(work: number): void {
  const budget = operationBudget.getStore();
  if (budget) budget.sinceYield += work;
}

/**
 * Run rule loading/parsing with pool debits suspended; charges inside count
 * for yielding only. Per-candidate matching keeps its normal accounting.
 */
export function withGlobOverheadOnly<T>(body: () => T): T {
  const store = operationBudget.getStore();
  if (!store) return body();
  const previous = store.overheadOnly;
  store.overheadOnly = true;
  try {
    return body();
  } finally {
    store.overheadOnly = previous;
  }
}

export function chargeGlobWork(work: number): void {
  const budget = operationBudget.getStore();
  if (!budget) return;
  budget.sinceYield += work;
  if (budget.overheadOnly || budget.pathRemaining === undefined) return;
  if ((budget.pathRemaining -= work) < 0) {
    throw new GlobWorkLimitError(
      "Path filtering exceeded its matching work limit.",
    );
  }
}

/** Async callers poll between paths, never from inside synchronous matching. */
export function globWorkNeedsYield(): boolean {
  const budget = operationBudget.getStore();
  if (!budget || budget.sinceYield < 100_000) return false;
  budget.sinceYield = 0;
  return true;
}

export function checkGlobLength(value: string, kind: "pattern" | "path"): void {
  const limit =
    kind === "pattern" ? MAX_GLOB_PATTERN_CHARS : MAX_GLOB_PATH_CHARS;
  if (value.length > limit) {
    throw new Error(`Glob ${kind} exceeds the ${limit}-character limit.`);
  }
}

export function checkGlobRuleCount(count: number): void {
  if (count > MAX_GLOB_RULES) {
    throw new Error(`Path filtering exceeds the ${MAX_GLOB_RULES}-rule limit.`);
  }
}

export function isGlobWorkLimitFailure(error: unknown): boolean {
  return (
    error instanceof GlobWorkLimitError ||
    (error instanceof Error && error.message.includes("matching work limit"))
  );
}

/** Attach a rule's provenance (label and pattern preview) to a work-limit failure. */
export function labeledGlobWorkError(
  label: string,
  pattern: string,
  cause: unknown,
): Error {
  if (!isGlobWorkLimitFailure(cause)) {
    return cause as Error;
  }
  const preview = pattern.length > 48 ? `${pattern.slice(0, 45)}…` : pattern;
  return new Error(
    `Glob matching exceeded its work limit at ${label} (pattern '${preview}').`,
    { cause },
  );
}

export function checkActiveRuleWeight(weight: number, context: string): void {
  if (weight > MAX_ACTIVE_RULE_WEIGHT) {
    throw new Error(
      `Path filtering exceeds the ${MAX_ACTIVE_RULE_WEIGHT.toLocaleString("en-US")}-unit active-rule limit for ${context}.`,
    );
  }
}
