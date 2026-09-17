import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { EngineError } from "./errors.js";
import { acquireReadWriteLock, type FileLock } from "./utils/lock.js";

/**
 * Exclusive destination-ownership protocol for staging-based publication
 * (migration, import, export). The destination is reserved at the start via
 * its write lock; destination contents are validated under that lock; staged
 * content is built inside the reservation; ownership (home identity, lock
 * identity, and the operation's token) is re-verified before publication and
 * before any cleanup; and the operation commits only when its release
 * actually releases. Foreign content is never deleted and never overwritten.
 */

export type DestinationReservation = {
  /** The reserved destination directory. */
  readonly destinationHome: string;
  /** Owned staging directory inside the reservation. */
  readonly stagingHome: string;
  /**
   * Verify ownership, run `finalize` (which must write the manifest/metadata
   * into the staging directory), move staged children into place with the
   * manifest last — rejecting any child-name collision rather than
   * overwriting — and commit by releasing the reservation. The commit point
   * is a verified successful release; after it, no error path cleans the
   * result. A failed release leaves everything in place for operator review.
   */
  publish(finalize: () => void): void;
  /**
   * Abort before commit: remove only provably owned staging while ownership
   * is verifiable, preserve everything else, and release the reservation
   * through the physical-ownership-checked release.
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
      homeIdentity: directoryIdentity(options.destinationHome),
      lockDir,
      lockIdentity: directoryIdentity(lockDir),
      token: lock.info.token,
      lock,
      committed: false,
    };
    mkdirSync(state.stagingHome);

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
  const children = readdirSync(state.stagingHome).sort((left, right) =>
    left === "manifest.json" ? 1 : right === "manifest.json" ? -1 : 0,
  );
  for (const child of children) {
    const target = join(state.destinationHome, child);
    if (existsSync(target)) {
      throw reservationError(
        "Destination child already exists; refusing to overwrite",
        `child=${child} destination=${state.destinationHome}`,
      );
    }
    renameSync(join(state.stagingHome, child), target);
  }
  rmSync(state.stagingHome, { recursive: true, force: true });

  // The commit point is a verified successful release. A failed release is
  // ownership loss: nothing is deleted, the result stays for operator
  // review, and the operation reports failure.
  const released = state.lock.release();
  if (!released) {
    throw reservationError(
      "Reservation ownership was lost at commit; published content left in place",
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
      rmSync(state.stagingHome, { recursive: true, force: true });
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
