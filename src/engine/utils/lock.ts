import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { detail, EngineError, errorDetails } from "../errors.js";

export type FileLock = {
  readonly path: string;
  readonly info: FileLockInfo;
  release(): void;
};

export type FileLockInfo = {
  token: string;
  pid: number;
  hostname: string;
  startedAt: number;
  operation: string;
};

type FileLockOptions = {
  operation: string;
  staleMs?: number;
};

const LOCK_INFO_FILE = "lock.json";
const DEFAULT_STALE_LOCK_MS = 6 * 60 * 60 * 1000;

function acquireExclusiveDirectoryLock(
  lockPath: string,
  options: FileLockOptions,
): FileLock {
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockPath);
      const identity = lockDirectoryIdentity(lockPath);
      const info = currentLockInfo(options.operation);
      writeFileSync(
        lockInfoPath(lockPath),
        `${JSON.stringify(info, null, 2)}\n`,
        "utf8",
      );

      return {
        path: lockPath,
        info,
        release: () => releaseFileLock(lockPath, info, identity),
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }

      if (
        cleanupStaleLock(lockPath, options.staleMs ?? DEFAULT_STALE_LOCK_MS)
      ) {
        continue;
      }

      throw lockBusyError(lockPath, options.operation);
    }
  }

  throw lockBusyError(lockPath, options.operation);
}

function assertExclusiveDirectoryUnlocked(
  lockPath: string,
  operation: string,
): void {
  if (!existsSync(lockPath)) {
    return;
  }

  if (cleanupStaleLock(lockPath, DEFAULT_STALE_LOCK_MS)) {
    return;
  }

  throw lockBusyError(lockPath, operation);
}

export function acquireReadWriteLock(
  lockPath: string,
  mode: "read" | "write",
  options: FileLockOptions,
): FileLock {
  return mode === "read"
    ? acquireReadLock(lockPath, options)
    : acquireWriteLock(lockPath, options);
}

export function assertNoWriteLock(lockPath: string, operation: string): void {
  assertExclusiveDirectoryUnlocked(writeLockPath(lockPath), operation);
}

function currentLockInfo(operation: string): FileLockInfo {
  return {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    startedAt: Date.now(),
    operation,
  };
}

function acquireReadLock(lockPath: string, options: FileLockOptions): FileLock {
  mkdirSync(dirname(lockPath), { recursive: true });
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const writePath = writeLockPath(lockPath);

  for (let attempt = 0; attempt < 2; attempt++) {
    if (existsSync(writePath)) {
      if (cleanupStaleLock(writePath, staleMs)) {
        continue;
      }

      throw lockBusyError(writePath, options.operation);
    }

    const info = currentLockInfo(options.operation);
    const readerPath = join(
      readersLockPath(lockPath),
      `${info.pid}-${info.token}`,
    );
    try {
      mkdirSync(readerPath, { recursive: true });
      const identity = lockDirectoryIdentity(readerPath);
      writeFileSync(
        lockInfoPath(readerPath),
        `${JSON.stringify(info, null, 2)}\n`,
        "utf8",
      );

      if (existsSync(writePath)) {
        releaseFileLock(readerPath, info, identity);
        if (cleanupStaleLock(writePath, staleMs)) {
          continue;
        }

        throw lockBusyError(writePath, options.operation);
      }

      return {
        path: readerPath,
        info,
        release: () => releaseFileLock(readerPath, info, identity),
      };
    } catch (error) {
      releaseFileLock(readerPath, info, lockDirectoryIdentity(readerPath));
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
    }
  }

  throw lockBusyError(writePath, options.operation);
}

function acquireWriteLock(
  lockPath: string,
  options: FileLockOptions,
): FileLock {
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const writePath = writeLockPath(lockPath);

  for (let attempt = 0; attempt < 2; attempt++) {
    const lock = acquireExclusiveDirectoryLock(writePath, options);
    if (!hasActiveReaders(lockPath, staleMs)) {
      return lock;
    }

    lock.release();
    throw readLockBusyError(lockPath, options.operation);
  }

  throw readLockBusyError(lockPath, options.operation);
}

function releaseFileLock(
  lockPath: string,
  owner: FileLockInfo,
  expectedIdentity: LockDirectoryIdentity | undefined,
): void {
  const current = readLockInfo(lockPath);
  if (current?.token !== owner.token) {
    return;
  }
  // Physical ownership: token equality alone cannot distinguish a replaced
  // directory carrying a copied token. Never delete another directory's
  // lock through this handle.
  if (!lockIdentityMatches(lockPath, expectedIdentity)) {
    return;
  }

  rmSync(lockPath, { recursive: true, force: true });
}

type LockDirectoryIdentity = {
  device: number;
  inode: number;
};

function lockDirectoryIdentity(
  lockPath: string,
): LockDirectoryIdentity | undefined {
  try {
    const info = statSync(lockPath);
    return { device: info.dev, inode: info.ino };
  } catch {
    return undefined;
  }
}

function lockIdentityMatches(
  lockPath: string,
  expected: LockDirectoryIdentity | undefined,
): boolean {
  if (!expected) {
    // No reference identity was captured; only a vanished directory counts
    // as a match (nothing remains to delete).
    return lockDirectoryIdentity(lockPath) === undefined;
  }
  const current = lockDirectoryIdentity(lockPath);
  return (
    current !== undefined &&
    current.device === expected.device &&
    current.inode === expected.inode
  );
}

function cleanupStaleLock(lockPath: string, staleMs: number): boolean {
  if (!existsSync(lockPath)) {
    return false;
  }

  const identityBefore = lockDirectoryIdentity(lockPath);
  const info = readLockInfo(lockPath);
  if (!isStaleLock(lockPath, info, staleMs)) {
    return false;
  }
  // Re-check physical identity before deleting another owner's lock: a
  // replaced directory is never reclaimed through this path.
  if (!lockIdentityMatches(lockPath, identityBefore)) {
    return false;
  }

  rmSync(lockPath, { recursive: true, force: true });
  return true;
}

function hasActiveReaders(lockPath: string, staleMs: number): boolean {
  const readersPath = readersLockPath(lockPath);
  if (!existsSync(readersPath)) {
    return false;
  }

  let entries: string[];
  try {
    entries = readdirSync(readersPath);
  } catch {
    return false;
  }

  let active = false;
  for (const entry of entries) {
    const readerPath = join(readersPath, entry);
    if (cleanupStaleLock(readerPath, staleMs)) {
      continue;
    }

    active = true;
  }

  return active;
}

function isStaleLock(
  lockPath: string,
  info: FileLockInfo | null,
  staleMs: number,
): boolean {
  void lockPath;
  void staleMs;
  // Age never proves inactivity: a known-live local owner is never stale at
  // any age, and unknown ownership (foreign host, missing or corrupt
  // metadata) must remain blocked rather than be reclaimed. Reclamation is
  // safe only for a verified-dead local owner. Recovering any other lock is
  // an explicit operator action after writers are quiescent.
  if (!info) {
    return false;
  }
  if (info.hostname !== hostname()) {
    return false;
  }
  return !processIsAlive(info.pid);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function readLockInfo(lockPath: string): FileLockInfo | null {
  try {
    const parsed = JSON.parse(
      readFileSync(lockInfoPath(lockPath), "utf8"),
    ) as Partial<FileLockInfo>;
    if (
      typeof parsed.token === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.startedAt === "number" &&
      typeof parsed.operation === "string"
    ) {
      return parsed as FileLockInfo;
    }
  } catch {
    return null;
  }

  return null;
}

function lockBusyError(
  lockPath: string,
  requestedOperation: string,
): EngineError {
  const owner = readLockInfo(lockPath);

  return new EngineError("Index unavailable", {
    code: "ZVEC_GREP.ENGINE.LOCK.BUSY",
    context: errorDetails([
      detail("lock", lockPath),
      detail("operation", requestedOperation),
      detail("ownerOperation", owner?.operation),
      detail("ownerPid", owner?.pid),
      detail("ownerHost", owner?.hostname),
      detail(
        "hint",
        "Another operation holds or last owned this lock. Locks are never reclaimed automatically when ownership is uncertain; after all writers are quiescent, remove the lock directory shown above manually to recover.",
      ),
    ]),
  });
}

function readLockBusyError(
  lockPath: string,
  requestedOperation: string,
): EngineError {
  const owner = firstActiveReaderInfo(lockPath);

  return new EngineError("Index unavailable", {
    code: "ZVEC_GREP.ENGINE.LOCK.BUSY",
    context: errorDetails([
      detail("lock", readersLockPath(lockPath)),
      detail("operation", requestedOperation),
      detail("ownerOperation", owner?.operation),
      detail("ownerPid", owner?.pid),
      detail("ownerHost", owner?.hostname),
      detail(
        "hint",
        "Another operation holds or last owned this lock. Locks are never reclaimed automatically when ownership is uncertain; after all writers are quiescent, remove the lock directory shown above manually to recover.",
      ),
    ]),
  });
}

function firstActiveReaderInfo(lockPath: string): FileLockInfo | null {
  const readersPath = readersLockPath(lockPath);
  if (!existsSync(readersPath)) {
    return null;
  }

  try {
    for (const entry of readdirSync(readersPath)) {
      const info = readLockInfo(join(readersPath, entry));
      if (info) {
        return info;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function lockInfoPath(lockPath: string): string {
  return join(lockPath, LOCK_INFO_FILE);
}

function writeLockPath(lockPath: string): string {
  return `${lockPath}.write`;
}

function readersLockPath(lockPath: string): string {
  return `${lockPath}.readers`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
