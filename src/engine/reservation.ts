import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { EngineError } from "./errors.js";
import { acquireReadWriteLock, type FileLock } from "./utils/lock.js";

/**
 * Exclusive destination-ownership protocol for staging-based publication
 * (migration, import, export). Lifecycle states are explicit:
 *
 *   reserved → publishing → published-complete → committed
 *                    ↘ rollback-incomplete (blocked for operator recovery)
 *
 * - The destination is reserved at the start via its write lock; destination
 *   contents are validated under that lock; a durable INCOMPLETE marker
 *   blocks readers, discovery and writers across process death and lock
 *   cleanup until verified completion or operator recovery.
 * - Ownership (home identity, lock identity, token) is verified before
 *   finalization, before every mutation, and before any cleanup. Every
 *   published child is recorded with the identity it had in staging; rollback
 *   compares against that recorded identity, never against a post-move
 *   observation, and never overwrites content found at a staging target.
 * - The marker is removed only by a checked transition: access errors,
 *   unexpected absence or a foreign token fail publication instead of being
 *   converted into success.
 * - Commit is a verified successful release. On ownership loss the operation
 *   performs no further writes into the destination. When rollback cannot
 *   complete and the marker is missing and unrestorable, the write lock is
 *   retained as the last block and the failure reports the required operator
 *   recovery. Foreign content is never deleted, overwritten, or merged into.
 *
 * These are best-effort fencing checks against filesystem interleavings,
 * not atomic protection against arbitrary external mutation.
 */

const INCOMPLETE_MARKER = "INCOMPLETE";

export type DestinationReservation = {
  /** The reserved destination directory. */
  readonly destinationHome: string;
  /** Owned staging directory inside the reservation. */
  readonly stagingHome: string;
  /**
   * Verify ownership, run `finalize` (which must write the manifest/metadata
   * into the staging directory), move staged children into place with the
   * manifest last — rejecting any child-name collision rather than
   * overwriting — remove the incomplete marker through a checked transition,
   * and commit by releasing the reservation. After a verified successful
   * release, no error path cleans the result. Any failure rolls back what it
   * provably owns, preserves blockage otherwise, and throws an error that
   * describes the state actually left behind.
   */
  publish(finalize: () => void): void;
  /**
   * Abort before commit: roll back any published children that are provably
   * owned, remove provably owned staging, clear the incomplete marker only
   * when cleanup is complete, and release the reservation through the
   * physical-ownership-checked release. Returns undefined when the
   * destination needs no further attention; otherwise a description of the
   * blockage or anomaly left behind and the required operator action.
   */
  abort(): string | undefined;
};

type DirectoryIdentity = {
  device: number;
  inode: number;
};

type PublishedChild = {
  name: string;
  /** Identity captured in staging before the move; rollback's ownership
   * reference, never a re-observation after the fact. */
  stagedIdentity: DirectoryIdentity | undefined;
  returned: boolean;
};

type ReservationState = {
  destinationHome: string;
  stagingHome: string;
  stagingIdentity: DirectoryIdentity | undefined;
  homeIdentity: DirectoryIdentity | undefined;
  lockDir: string;
  lockIdentity: DirectoryIdentity | undefined;
  token: string;
  lock: FileLock;
  committed: boolean;
  published: PublishedChild[];
  /** Set once failure handling ran; repeat aborts must not redo cleanup. */
  finalized: boolean;
  /** Set when the write lock is deliberately retained as the last block. */
  lockRetainedForBlockage: boolean;
};

export function reserveDestination(options: {
  destinationHome: string;
  operation: string;
  /** Children whose presence marks an existing index. */
  existingIndexMarkers?: readonly string[];
}): DestinationReservation {
  const markers = options.existingIndexMarkers ?? ["manifest.json"];
  const lockDir = join(options.destinationHome, "locks", "home.write");
  const lock = acquireReadWriteLock(
    join(options.destinationHome, "locks", "home"),
    "write",
    { operation: options.operation },
  );

  try {
    // Destination validation happens under the acquired lock, never from an
    // absence check or existence observed before it.
    const indexMarkers = markers.filter((marker) =>
      existsSync(join(options.destinationHome, marker)),
    );
    if (indexMarkers.length > 0) {
      throw reservationError(
        "Destination already contains a workspace index",
        `${options.destinationHome} markers=${indexMarkers.join(",")}`,
      );
    }
    if (existsSync(join(options.destinationHome, INCOMPLETE_MARKER))) {
      throw reservationError(
        "Destination contains an incomplete reserved result; recover it manually after writers are quiescent (remove the INCOMPLETE marker and its partial contents, then retry)",
        options.destinationHome,
      );
    }
    const unrelated = readdirSync(options.destinationHome).filter(
      (entry) => entry !== "locks",
    );
    if (unrelated.length > 0) {
      throw reservationError(
        "Destination contains unrelated contents and cannot be claimed",
        `${options.destinationHome} entries=${unrelated.join(",")}`,
      );
    }

    const state: ReservationState = {
      destinationHome: options.destinationHome,
      stagingHome: join(options.destinationHome, `staging-${lock.info.token}`),
      stagingIdentity: undefined,
      homeIdentity: directoryIdentity(options.destinationHome),
      lockDir,
      lockIdentity: directoryIdentity(lockDir),
      token: lock.info.token,
      lock,
      committed: false,
      published: [],
      finalized: false,
      lockRetainedForBlockage: false,
    };
    mkdirSync(state.stagingHome);
    state.stagingIdentity = directoryIdentity(state.stagingHome);
    // The durable marker blocks readers, discovery and writers across
    // process death and lock cleanup until verified completion or the
    // documented operator recovery. "wx": the validated-empty destination
    // must not already contain one; never overwrite.
    writeFileSync(
      join(state.destinationHome, INCOMPLETE_MARKER),
      `${JSON.stringify(
        {
          token: state.token,
          operation: options.operation,
          pid: process.pid,
          startedAt: Date.now(),
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );

    return {
      destinationHome: state.destinationHome,
      stagingHome: state.stagingHome,
      publish(finalize) {
        publishReservation(state, finalize);
      },
      abort() {
        return abortReservation(state);
      },
    };
  } catch (error) {
    lock.release();
    throw error;
  }
}

/**
 * Append a reservation cleanup description to a thrown error, preserving its
 * code so classification and error-code checks still apply.
 */
export function appendReservationCleanup(
  error: unknown,
  cleanup: string,
): Error {
  const suffix = ` [reservation cleanup: ${cleanup}]`;
  if (error instanceof EngineError) {
    return new EngineError(`${error.message}${suffix}`, {
      code: error.code,
      context: error.context,
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message}${suffix}`, { cause: error });
}

function publishReservation(
  state: ReservationState,
  finalize: () => void,
): void {
  assertReservationIntact(state);
  // Finalize first: the manifest/metadata is written into staging, then
  // moved last so readers never see a manifest without its content.
  finalize();
  // Ownership is verified again after finalization and before every
  // mutation; any loss stops the operation without publishing.
  assertReservationIntact(state);
  const children = readdirSync(state.stagingHome).sort((left, right) =>
    left === "manifest.json" ? 1 : right === "manifest.json" ? -1 : 0,
  );
  try {
    for (const child of children) {
      assertReservationIntact(state);
      const target = join(state.destinationHome, child);
      if (existsSync(target)) {
        throw reservationError(
          "Destination child already exists; refusing to overwrite",
          `child=${child} destination=${state.destinationHome}`,
        );
      }
      const stagedIdentity = directoryIdentity(join(state.stagingHome, child));
      renameSync(join(state.stagingHome, child), target);
      state.published.push({ name: child, stagedIdentity, returned: false });
      if (!identityMatches(directoryIdentity(target), stagedIdentity)) {
        throw reservationError(
          "Moved child lost its identity at the destination",
          `child=${child} destination=${state.destinationHome}`,
        );
      }
    }
  } catch (error) {
    throw failWithRollback(state, error);
  }
  assertReservationIntact(state);
  // The marker transition is checked: absence, replacement or removal
  // failure can never be converted into successful publication.
  try {
    removeIncompleteMarkerChecked(state);
  } catch (error) {
    throw failWithRollback(state, error);
  }
  // Staging must be empty after the moves; a non-recursive rmdir fails
  // loudly on unexpected content instead of deleting it.
  const stagingIdentity = directoryIdentity(state.stagingHome);
  if (!identityMatches(stagingIdentity, state.stagingIdentity)) {
    throw failWithRollback(
      state,
      reservationError(
        "Staging directory lost its identity before cleanup",
        `staging=${state.stagingHome}`,
      ),
    );
  }
  try {
    rmdirSync(state.stagingHome);
  } catch (error) {
    throw failWithRollback(
      state,
      reservationError(
        `Staging directory could not be removed after publication (${errorCode(
          error,
        )}); unexpected content is preserved`,
        `staging=${state.stagingHome}`,
      ),
    );
  }

  // The commit point is a verified successful release. A failed release is
  // ownership loss: no further writes into the destination, and the
  // operation reports failure for operator review.
  const released = state.lock.release();
  if (!released) {
    state.finalized = true;
    throw reservationError(
      "Reservation ownership was lost at commit; the destination was left untouched after marker removal and is governed by the conflicting lock state; operator review required",
      `destination=${state.destinationHome}`,
    );
  }
  state.committed = true;
}

/**
 * Failure finalizer for publication: roll back provably owned children, then
 * preserve the remaining blockage and describe the state left behind. Never
 * performs a write after ownership loss.
 */
function failWithRollback(
  state: ReservationState,
  cause: unknown,
): EngineError {
  state.finalized = true;
  const causeMessage =
    cause instanceof EngineError
      ? cause.message
      : cause instanceof Error
        ? cause.message
        : String(cause);
  const rollbackComplete = rollbackPublishedChildren(state);
  if (rollbackComplete) {
    const marker = ensureMarkerPreserved(state);
    const blockage =
      marker === "present"
        ? "by the INCOMPLETE marker"
        : marker === "foreign"
          ? "by a foreign INCOMPLETE marker preserved for operator review"
          : "only by operator review (no marker could be preserved)";
    const released = state.lock.release();
    return reservationError(
      `${causeMessage}; publication was rolled back completely; the destination remains blocked ${blockage}${released ? "" : " and the lock release reported ownership loss"}; recover after all writers are quiescent`,
      `destination=${state.destinationHome}`,
    );
  }
  const marker = ensureMarkerPreserved(state);
  if (marker !== "absent") {
    const released = state.lock.release();
    return reservationError(
      `${causeMessage}; rollback is incomplete: published payload remains at the destination, which stays blocked by ${marker === "present" ? "the INCOMPLETE marker" : "a foreign INCOMPLETE marker preserved for operator review"}${released ? "" : " and an ownership-conflicted lock"}; recover by removing the marker and partial contents after all writers are quiescent`,
      `destination=${state.destinationHome}`,
    );
  }
  // Rollback incomplete and the marker is missing and unrestorable: retain
  // the write lock as the last effective block and report the recovery.
  state.lockRetainedForBlockage = true;
  return reservationError(
    `${causeMessage}; rollback is incomplete and the INCOMPLETE marker is missing: partial payload remains at the destination; the write lock is retained as the last block and no further writes were made; recover by removing the lock directory and the partial contents after all writers are quiescent`,
    `destination=${state.destinationHome}`,
  );
}

/**
 * Move published children back into staging, one ownership check at a time.
 * Compares each destination child against the identity recorded in staging
 * before the move; stops at the first mismatch, refusal or I/O failure and
 * leaves everything else untouched. Never overwrites content found at a
 * staging target; a child already back at its staging target with the
 * recorded staged identity and absent from the destination counts as an
 * earlier verified return.
 */
function rollbackPublishedChildren(state: ReservationState): boolean {
  for (const record of [...state.published].reverse()) {
    if (record.returned) {
      continue;
    }
    if (!reservationIntact(state)) {
      return false;
    }
    if (
      !identityMatches(
        directoryIdentity(state.stagingHome),
        state.stagingIdentity,
      )
    ) {
      return false;
    }
    const destinationChild = join(state.destinationHome, record.name);
    const stagingChild = join(state.stagingHome, record.name);
    if (
      !identityMatches(
        directoryIdentity(destinationChild),
        record.stagedIdentity,
      )
    ) {
      // Replaced or removed at the destination: if the original already sits
      // at its staging target with the recorded identity, an earlier verified
      // return completed; otherwise the foreign state is preserved.
      if (
        directoryIdentity(destinationChild) === undefined &&
        identityMatches(directoryIdentity(stagingChild), record.stagedIdentity)
      ) {
        record.returned = true;
        continue;
      }
      return false;
    }
    // The destination child is provably ours; its staging target must be
    // empty. Any content there is unexpected and never overwritten.
    if (directoryIdentity(stagingChild) !== undefined) {
      return false;
    }
    try {
      renameSync(destinationChild, stagingChild);
    } catch {
      return false;
    }
    if (
      !identityMatches(directoryIdentity(stagingChild), record.stagedIdentity)
    ) {
      return false;
    }
    record.returned = true;
  }
  return state.published.every((record) => record.returned);
}

/**
 * Ensure the durable blockage survives a failed operation. Returns "present"
 * when a marker with this reservation's token (or an unreadable marker, which
 * is left as blockage) is in place, including after a successful restore;
 * "foreign" when a replaced marker with another token stands (preserved,
 * never touched); "absent" when no trustworthy blockage exists. Restore is
 * attempted only while reservation ownership is verifiable, and nothing is
 * written after ownership loss.
 */
function ensureMarkerPreserved(
  state: ReservationState,
): "present" | "foreign" | "absent" {
  const marker = join(state.destinationHome, INCOMPLETE_MARKER);
  try {
    const current = JSON.parse(readFileSync(marker, "utf8")) as {
      token?: string;
    };
    return current?.token === state.token ? "present" : "foreign";
  } catch (error) {
    if (!isAbsence(error)) {
      // Unreadable but present: left as blockage, never overwritten.
      return "present";
    }
  }
  if (!reservationIntact(state)) {
    return "absent";
  }
  try {
    // "wx": never follow a replaced marker path or overwrite anything.
    writeFileSync(
      marker,
      `${JSON.stringify(
        {
          token: state.token,
          pid: process.pid,
          startedAt: Date.now(),
          operation: "rollback-block",
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    return "present";
  } catch {
    return "absent";
  }
}

/**
 * The publication marker transition. Any anomaly — absence, unreadable
 * content, a foreign token, or a removal failure — throws instead of being
 * converted into successful publication.
 */
function removeIncompleteMarkerChecked(state: ReservationState): void {
  const marker = join(state.destinationHome, INCOMPLETE_MARKER);
  let current: { token?: string };
  try {
    current = JSON.parse(readFileSync(marker, "utf8")) as { token?: string };
  } catch (error) {
    if (isAbsence(error)) {
      throw reservationError(
        "Incomplete marker is unexpectedly absent at publication; refusing to report success over external interference",
        `destination=${state.destinationHome}`,
      );
    }
    throw reservationError(
      `Incomplete marker is unreadable at publication (${errorCode(error)})`,
      `destination=${state.destinationHome}`,
    );
  }
  if (current?.token !== state.token) {
    throw reservationError(
      "Incomplete marker was replaced by foreign state; refusing to publish over it",
      `destination=${state.destinationHome}`,
    );
  }
  try {
    rmSync(marker, { force: true });
  } catch (error) {
    throw reservationError(
      `Failed to remove the incomplete marker (${errorCode(error)})`,
      `destination=${state.destinationHome}`,
    );
  }
}

function abortReservation(state: ReservationState): string | undefined {
  if (state.committed) {
    return undefined;
  }
  if (state.finalized || state.lockRetainedForBlockage) {
    // Failure handling already ran (or deliberately retained the lock); its
    // error describes the state left behind.
    return undefined;
  }
  try {
    if (!reservationIntact(state)) {
      // Ownership lost: no writes into the destination at all. The release
      // is ownership-checked and will not delete a replacement's lock.
      state.lock.release();
      return "aborted without cleanup: reservation ownership was lost; the destination was left untouched for operator review";
    }
    if (state.published.length > 0) {
      const rollbackComplete = rollbackPublishedChildren(state);
      if (!rollbackComplete) {
        state.finalized = true;
        const marker = ensureMarkerPreserved(state);
        if (marker === "present") {
          state.lock.release();
          return "abort left partial published payload in place; the destination remains blocked by the INCOMPLETE marker; recover by removing the marker and partial contents after all writers are quiescent";
        }
        if (marker === "foreign") {
          state.lock.release();
          return "abort left partial published payload in place; the destination remains blocked by a foreign INCOMPLETE marker preserved for operator review; recover after all writers are quiescent";
        }
        state.lockRetainedForBlockage = true;
        return "abort left partial published payload in place and the INCOMPLETE marker is missing; the write lock is retained as the last block; recover by removing the lock directory and partial contents after all writers are quiescent";
      }
    }
    // Nothing remains published: remove provably owned staging, then clear
    // the marker through a checked transition, then release.
    if (
      identityMatches(
        directoryIdentity(state.stagingHome),
        state.stagingIdentity,
      )
    ) {
      try {
        rmSync(state.stagingHome, { recursive: true, force: true });
      } catch {
        // Reported through the returned description.
      }
    }
    const markerNote = clearMarkerAfterCleanup(state);
    const released = state.lock.release();
    const notes = [markerNote];
    if (!released) {
      notes.push("the lock release reported ownership loss");
    }
    return notes.filter((note) => note.length > 0).length > 0
      ? `abort completed with reservations: ${notes.join("; ")}`
      : undefined;
  } finally {
    state.finalized = true;
  }
}

/**
 * Marker removal during a complete cleanup. Returns a description of any
 * anomaly; the marker is only ever removed when it carries this
 * reservation's token.
 */
function clearMarkerAfterCleanup(state: ReservationState): string {
  const marker = join(state.destinationHome, INCOMPLETE_MARKER);
  let current: { token?: string };
  try {
    current = JSON.parse(readFileSync(marker, "utf8")) as { token?: string };
  } catch (error) {
    if (isAbsence(error)) {
      return "the INCOMPLETE marker was already absent (external interference; operator review required)";
    }
    return `the INCOMPLETE marker is unreadable (${errorCode(error)}) and was left in place as blockage`;
  }
  if (current?.token !== state.token) {
    return "the INCOMPLETE marker was replaced by foreign state and was preserved; operator review required";
  }
  try {
    rmSync(marker, { force: true });
    return "";
  } catch (error) {
    return `the INCOMPLETE marker could not be removed (${errorCode(error)}); the destination remains blocked and requires operator recovery`;
  }
}

function reservationIntact(state: ReservationState): boolean {
  if (
    !identityMatches(
      directoryIdentity(state.destinationHome),
      state.homeIdentity,
    )
  ) {
    return false;
  }
  if (!identityMatches(directoryIdentity(state.lockDir), state.lockIdentity)) {
    return false;
  }
  const info = readLockInfoSafe(state.lockDir);
  return info?.token === state.token;
}

function assertReservationIntact(state: ReservationState): void {
  if (!reservationIntact(state)) {
    throw reservationError(
      "Destination reservation ownership was lost; aborting without touching the destination",
      `destination=${state.destinationHome}`,
    );
  }
}

function identityMatches(
  current: DirectoryIdentity | undefined,
  expected: DirectoryIdentity | undefined,
): boolean {
  return (
    current !== undefined &&
    expected !== undefined &&
    current.device === expected.device &&
    current.inode === expected.inode
  );
}

function directoryIdentity(path: string): DirectoryIdentity | undefined {
  try {
    const info = statSync(path);
    return { device: info.dev, inode: info.ino };
  } catch {
    return undefined;
  }
}

function readLockInfoSafe(lockDir: string): { token?: string } | null {
  try {
    return JSON.parse(readFileSync(join(lockDir, "lock.json"), "utf8")) as {
      token?: string;
    };
  } catch {
    return null;
  }
}

function isAbsence(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "unknown";
}

function reservationError(message: string, context: string): EngineError {
  return new EngineError(message, {
    code: "ZVEC_GREP.ENGINE.RESERVATION.FAILED",
    context,
  });
}
