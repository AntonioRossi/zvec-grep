import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { EngineError } from "./errors.js";
import { acquireReadWriteLock, type FileLock } from "./utils/lock.js";

/**
 * Exclusive destination-ownership protocol for staging-based publication
 * (migration, import, export). The destination is reserved at the start via
 * its write lock; destination contents are validated under that lock; a
 * durable INCOMPLETE marker blocks readers, discovery and writers across
 * process death and lock cleanup until verified completion or operator
 * recovery; ownership (home identity, lock identity, token) is verified
 * before finalization, before every mutation, and before any cleanup; and
 * the operation commits only when its release actually releases. Foreign
 * content is never deleted, overwritten, or merged into.
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
   * overwriting — remove the incomplete marker, and commit by releasing the
   * reservation. After a verified successful release, no error path cleans
   * the result. A failed release leaves the marker in place and reports
   * failure.
   */
  publish(finalize: () => void): void;
  /**
   * Abort before commit: remove only provably owned staging while ownership
   * is verifiable, roll back any partially moved children, clear the
   * incomplete marker, preserve everything else, and release the
   * reservation through the physical-ownership-checked release.
   */
  abort(): void;
};

type DirectoryIdentity = {
  device: number;
  inode: number;
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
    };
    mkdirSync(state.stagingHome);
    state.stagingIdentity = directoryIdentity(state.stagingHome);
    // The durable marker blocks readers, discovery and writers across
    // process death and lock cleanup until verified completion or the
    // documented operator recovery.
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
    );

    return {
      destinationHome: state.destinationHome,
      stagingHome: state.stagingHome,
      publish(finalize) {
        publishReservation(state, finalize);
      },
      abort() {
        abortReservation(state);
      },
    };
  } catch (error) {
    lock.release();
    throw error;
  }
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
  const moved: string[] = [];
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
      moved.push(child);
      if (!identityMatches(directoryIdentity(target), stagedIdentity)) {
        throw reservationError(
          "Moved child lost its identity at the destination",
          `child=${child} destination=${state.destinationHome}`,
        );
      }
    }
  } catch (error) {
    // Rollback is gated on continued reservation ownership and ownership of
    // each moved child; on any loss, stop and leave foreign content intact.
    if (reservationIntact(state)) {
      for (const child of moved.reverse()) {
        try {
          renameSync(
            join(state.destinationHome, child),
            join(state.stagingHome, child),
          );
        } catch {
          break;
        }
      }
    }
    throw error;
  }
  assertReservationIntact(state);
  const stagingIdentity = directoryIdentity(state.stagingHome);
  if (!identityMatches(stagingIdentity, state.stagingIdentity)) {
    throw reservationError(
      "Staging directory lost its identity before cleanup",
      `staging=${state.stagingHome}`,
    );
  }
  rmSync(state.stagingHome, { recursive: true, force: true });
  removeIncompleteMarker(state);

  // The commit point is a verified successful release. A failed release is
  // ownership loss: the marker goes back in place, nothing is deleted, and
  // the operation reports failure for operator review.
  const released = state.lock.release();
  if (!released) {
    writeIncompleteMarker(state);
    state.committed = false;
    throw reservationError(
      "Reservation ownership was lost at commit; the incomplete destination remains blocked for operator review",
      `destination=${state.destinationHome}`,
    );
  }
  state.committed = true;
}

function abortReservation(state: ReservationState): void {
  // Never clean a committed result; never touch a reservation whose
  // ownership cannot be verified.
  if (state.committed) {
    return;
  }
  try {
    if (reservationIntact(state)) {
      if (
        identityMatches(
          directoryIdentity(state.stagingHome),
          state.stagingIdentity,
        )
      ) {
        rmSync(state.stagingHome, { recursive: true, force: true });
      }
      removeIncompleteMarker(state);
    }
  } finally {
    state.lock.release();
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

function removeIncompleteMarker(state: ReservationState): void {
  const marker = join(state.destinationHome, INCOMPLETE_MARKER);
  try {
    const current = JSON.parse(readFileSync(marker, "utf8")) as {
      token?: string;
    };
    if (current.token !== state.token) {
      return;
    }
    rmSync(marker, { force: true });
  } catch {
    // Absent or unreadable markers are left for operator review.
  }
}

function writeIncompleteMarker(state: ReservationState): void {
  try {
    writeFileSync(
      join(state.destinationHome, INCOMPLETE_MARKER),
      `${JSON.stringify(
        {
          token: state.token,
          pid: process.pid,
          startedAt: Date.now(),
          operation: "commit-failed",
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    // The marker is best-effort; the operation still reports failure.
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

function reservationError(message: string, context: string): EngineError {
  return new EngineError(message, {
    code: "ZVEC_GREP.ENGINE.RESERVATION.FAILED",
    context,
  });
}
