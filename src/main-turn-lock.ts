import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { processIsAlive } from "./process.js";

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type MainTurnLockResult =
  | { status: "acquired" }
  | { status: "busy"; ownerPid: number }
  | { status: "unreadable"; path: string };

export type MainTurnLockExecutionResult<T> =
  | Exclude<MainTurnLockResult, { status: "acquired" }>
  | { status: "completed"; value: T; releaseError?: unknown };

/** Acquire, execute, and release a continuation as one testable lifecycle. */
export async function withMainTurnLock<T>(
  lock: MainTurnLock,
  run: () => Promise<T>,
): Promise<MainTurnLockExecutionResult<T>> {
  let acquired: MainTurnLockResult;
  try {
    acquired = await lock.acquire();
  } catch (error) {
    try {
      // acquire() can fail after installing the main lock if recovery-marker
      // cleanup fails; release() only removes a token owned by this instance.
      lock.release();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "Continuation lock acquisition and cleanup both failed");
    }
    throw error;
  }

  if (acquired.status !== "acquired") return acquired;

  let value!: T;
  let runError: unknown;
  let runFailed = false;
  try {
    value = await run();
  } catch (error) {
    runFailed = true;
    runError = error;
  }

  try {
    lock.release();
  } catch (releaseError) {
    if (runFailed) {
      throw new AggregateError([runError, releaseError], "Continuation and lock release both failed");
    }
    // The continuation itself completed. A lock that could not be removed is
    // cleanup debt, not a failed turn: the next contender reclaims it once
    // this PID exits. Report it so the caller can warn without re-running the
    // already-adopted continuation.
    return { status: "completed", value, releaseError };
  }

  if (runFailed) throw runError;
  return { status: "completed", value };
}

interface LockOwner {
  pid: number;
  token: string;
  at: string;
}

function readOwner(path: string): LockOwner | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("pid" in value) ||
      !("token" in value) ||
      !("at" in value)
    ) return undefined;

    const { pid, token, at } = value;
    if (
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof token !== "string" ||
      token.length === 0 ||
      typeof at !== "string"
    ) return undefined;

    return { pid, token, at };
  } catch {
    return undefined;
  }
}

/**
 * Cross-process exclusive lock for a parked main-turn continuation.
 *
 * Exclusive file creation (`open(..., "wx")`) is the atomic decision point;
 * it works on filesystems that do not support hard links. The owner record is
 * written immediately after creation. A contender that observes an incomplete
 * record retries briefly before failing closed, because the writer holds the
 * name only between `open` and `write` — reporting that window as a corrupt
 * lock would tell the user to delete a lock another window is actively
 * holding. A record that stays unreadable is reported with its path.
 *
 * Stale-owner reclamation is serialized with a second exclusive recovery file.
 * Recovery markers left by a crashed reaper are reported with their path for
 * manual cleanup after verifying the recorded PID is no longer active. When a
 * reaper finishes and removes its marker between a contender's failed create
 * and its read, the contender retries the acquisition instead of reporting a
 * marker that no longer exists.
 */
/** Read attempts cover the open-to-write window of the owner record. */
const OWNER_READ_ATTEMPTS = 10;
const OWNER_READ_RETRY_MS = 2;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class MainTurnLock {
  private readonly lockPath: string;
  private readonly recoveryPath: string;
  private token: string | undefined;

  constructor(
    manifestPath: string,
    private readonly isAlive: (pid: number) => boolean = processIsAlive,
  ) {
    this.lockPath = `${manifestPath}.continue-lock`;
    this.recoveryPath = `${this.lockPath}.recovery`;
  }

  /** The lock file this instance claims, for user-facing cleanup messages. */
  get path(): string {
    return this.lockPath;
  }

  async acquire(): Promise<MainTurnLockResult> {
    if (this.token) {
      throw new Error(`This MainTurnLock instance already owns ${this.lockPath}`);
    }

    mkdirSync(dirname(this.lockPath), { recursive: true });
    const owner: LockOwner = {
      pid: process.pid,
      token: randomUUID(),
      at: new Date().toISOString(),
    };

    if (this.createExclusive(this.lockPath, owner)) {
      this.token = owner.token;
      return { status: "acquired" };
    }

    const current = await this.readOwnerRecord(this.lockPath);
    if (!current) {
      if (!existsSync(this.lockPath) && this.createExclusive(this.lockPath, owner)) {
        this.token = owner.token;
        return { status: "acquired" };
      }
      return { status: "unreadable", path: this.lockPath };
    }
    if (this.isAlive(current.pid)) return { status: "busy", ownerPid: current.pid };

    return this.reclaimStale(owner);
  }

  /** Release only the exact lock record created by this instance. */
  release(): void {
    if (!this.token) return;
    this.unlinkOwned(this.lockPath, this.token);
    this.token = undefined;
  }

  private async reclaimStale(owner: LockOwner): Promise<MainTurnLockResult> {
    if (!this.createExclusive(this.recoveryPath, owner)) {
      const reaper = await this.readOwnerRecord(this.recoveryPath);
      if (!reaper) {
        // The reaper finished and removed its marker between our create and
        // read. Retry the ordinary acquisition instead of reporting a marker
        // that no longer exists.
        if (!existsSync(this.recoveryPath)) return this.acquire();
        return { status: "unreadable", path: this.recoveryPath };
      }
      if (this.isAlive(reaper.pid)) return { status: "busy", ownerPid: reaper.pid };
      return { status: "unreadable", path: this.recoveryPath };
    }

    try {
      // Only one reaper can remove stale owners at a time. Fast-path claimants
      // may still race to create the vacant lock; exclusive creation picks one.
      for (;;) {
        const current = await this.readOwnerRecord(this.lockPath);
        if (!current) {
          if (!existsSync(this.lockPath)) {
            if (this.createExclusive(this.lockPath, owner)) {
              this.token = owner.token;
              return { status: "acquired" };
            }
            continue;
          }
          return { status: "unreadable", path: this.lockPath };
        }
        if (this.isAlive(current.pid)) return { status: "busy", ownerPid: current.pid };

        this.unlinkIfExists(this.lockPath);
        if (this.createExclusive(this.lockPath, owner)) {
          this.token = owner.token;
          return { status: "acquired" };
        }
      }
    } finally {
      this.unlinkOwned(this.recoveryPath, owner.token);
    }
  }

  /**
   * Read an owner record, tolerating the brief incomplete window between
   * `open(..., "wx")` and its write. Returns `undefined` for an absent file
   * immediately, and for a record that stayed unreadable after the retries.
   * Callers distinguish the two with `existsSync`.
   */
  private async readOwnerRecord(path: string): Promise<LockOwner | undefined> {
    for (let attempt = 0; attempt < OWNER_READ_ATTEMPTS; attempt++) {
      const owner = readOwner(path);
      if (owner) return owner;
      if (!existsSync(path)) return undefined;
      await delay(OWNER_READ_RETRY_MS);
    }
    return undefined;
  }

  private createExclusive(path: string, owner: LockOwner): boolean {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw new Error(`Cannot create continuation lock at ${path}: ${errorMessage(error)}`);
    }

    try {
      writeFileSync(fd, JSON.stringify(owner));
      closeSync(fd);
      return true;
    } catch (error) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write/close error.
      }
      this.unlinkIfExists(path);
      throw new Error(`Cannot write continuation lock at ${path}: ${errorMessage(error)}`);
    }
  }

  private unlinkIfExists(path: string): void {
    try {
      unlinkSync(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  private unlinkOwned(path: string, token: string): void {
    const owner = readOwner(path);
    if (owner?.pid !== process.pid || owner.token !== token) return;
    this.unlinkIfExists(path);
  }
}
