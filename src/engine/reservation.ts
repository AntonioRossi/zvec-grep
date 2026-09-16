import {
  existsSync,
  mkdirSync,
  readdirSync,
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
 * its write lock, staged content is built inside the reservation, and
 * publication commits exactly once when the reservation is released after
 * the manifest is written. A competing writer or reader meets the lock;
 * a replaced reservation aborts without merging or deleting foreign content.
 */

export type DestinationReservation = {
  /** The reserved destination directory. */
  readonly destinationHome: string;
  /** Owned staging directory inside the reservation. */
  readonly stagingHome: string;
  /**
   * Verify the reservation is intact, run `finalize` (which must write the
   * manifest/metadata into the staging directory), move staged children
   * into place with the manifest last, and commit by releasing the
   * reservation. After commit, no error path cleans the result.
   */
  publish(finalize: () => void): void;
  /**
   * Abort before commit: remove only provably owned staging, preserve
   * anything not created by this operation, and release the reservation
   * through the physical-ownership-checked release.
   */
  abort(): void;
};

type ReservationState = {
  destinationHome: string;
  stagingHome: string;
  homeIdentity: DirectoryIdentity | undefined;
  createdHome: boolean;
  lock: FileLock;
  committed: boolean;
};

type DirectoryIdentity = {
  device: number;
  inode: number;
};

export function reserveDestination(options: {
  destinationHome: string;
  operation: string;
  /** Children whose presence marks an existing index. */
  existingIndexMarkers?: readonly string[];
}): DestinationReservation {
  const markers = options.existingIndexMarkers ?? ["manifest.json"];
  if (
    markers.some((marker) => existsSync(join(options.destinationHome, marker)))
  ) {
    throw reservationError(
      "Destination already contains a workspace index",
      options.destinationHome,
    );
  }

  const preExisted = existsSync(options.destinationHome);
  const lock = acquireReadWriteLock(
    join(options.destinationHome, "locks", "home"),
    "write",
    { operation: options.operation },
  );

  const state: ReservationState = {
    destinationHome: options.destinationHome,
    stagingHome: "",
    homeIdentity: directoryIdentity(options.destinationHome),
    createdHome: !preExisted,
    lock,
    committed: false,
  };
  state.stagingHome = join(
    options.destinationHome,
    `staging-${state.lock.info.token}`,
  );

  try {
    mkdirSync(state.stagingHome);
  } catch (error) {
    state.lock.release();
    throw error;
  }

  return {
    destinationHome: state.destinationHome,
    stagingHome: state.stagingHome,
    publish(finalize) {
      assertReservationIntact(state);
      // Finalize first: the manifest/metadata is written into staging, then
      // moved last so readers never see a manifest without its content.
      finalize();
      const children = readdirSync(state.stagingHome).sort((left, right) =>
        left === "manifest.json" ? 1 : right === "manifest.json" ? -1 : 0,
      );
      for (const child of children) {
        renameSync(
          join(state.stagingHome, child),
          join(state.destinationHome, child),
        );
      }
      rmSync(state.stagingHome, { recursive: true, force: true });
      // Single commit point: availability begins at reservation release.
      state.committed = true;
      state.lock.release();
    },
    abort() {
      // Never clean a committed result; never touch a replaced reservation.
      if (state.committed) {
        return;
      }
      try {
        if (reservationIntact(state)) {
          rmSync(state.stagingHome, { recursive: true, force: true });
          if (state.createdHome) {
            rmSync(state.destinationHome, { recursive: true, force: true });
          }
        }
      } finally {
        state.lock.release();
      }
    },
  };
}

function reservationIntact(state: ReservationState): boolean {
  const current = directoryIdentity(state.destinationHome);
  return (
    state.homeIdentity !== undefined &&
    current !== undefined &&
    current.device === state.homeIdentity.device &&
    current.inode === state.homeIdentity.inode
  );
}

function assertReservationIntact(state: ReservationState): void {
  if (!reservationIntact(state)) {
    throw reservationError(
      "Destination reservation was replaced before publication; aborting without touching the replacement",
      `destination=${state.destinationHome}`,
    );
  }
}

function directoryIdentity(path: string): DirectoryIdentity | undefined {
  try {
    const info = statSync(path);
    return { device: info.dev, inode: info.ino };
  } catch {
    return undefined;
  }
}

function reservationError(message: string, context: string): EngineError {
  return new EngineError(message, {
    code: "ZVEC_GREP.ENGINE.RESERVATION.FAILED",
    context,
  });
}
