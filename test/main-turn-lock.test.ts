import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MainTurnLock, withMainTurnLock } from "../src/main-turn-lock.js";
import { processIsAlive } from "../src/process.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "main-turn-lock-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function lockFile(dir: string): string {
  return join(dir, "session.json.continue-lock");
}

function owner(pid: number, token = `token-${pid}`) {
  return { pid, token, at: "2026-01-01T00:00:00.000Z" };
}

describe("MainTurnLock", () => {
  it("admits one owner, reports the other as busy, and releases only its own lock", async () => {
    const dir = tempDir();
    const file = lockFile(dir);
    const first = new MainTurnLock(join(dir, "session.json"));
    const second = new MainTurnLock(join(dir, "session.json"));

    expect(await first.acquire()).toEqual({ status: "acquired" });
    expect(await second.acquire()).toEqual({ status: "busy", ownerPid: process.pid });
    expect(readdirSync(dir)).toEqual(["session.json.continue-lock"]);

    first.release();
    expect(existsSync(file)).toBe(false);
    expect(await second.acquire()).toEqual({ status: "acquired" });
    second.release();
  });

  it("reclaims an abandoned lock only when the injected liveness probe says its owner is gone", async () => {
    const dir = tempDir();
    const file = lockFile(dir);
    writeFileSync(file, JSON.stringify(owner(1234)));
    const lock = new MainTurnLock(join(dir, "session.json"), pid => pid !== 1234);

    expect(await lock.acquire()).toEqual({ status: "acquired" });
    expect(JSON.parse(readFileSync(file, "utf-8"))).toMatchObject({ pid: process.pid });
    expect(existsSync(`${file}.recovery`)).toBe(false);
    expect(readdirSync(dir)).toEqual(["session.json.continue-lock"]);
    lock.release();
  });

  it("returns an actionable unreadable result for a malformed lock", async () => {
    const dir = tempDir();
    const file = lockFile(dir);
    writeFileSync(file, "not-json");
    const lock = new MainTurnLock(join(dir, "session.json"), () => false);

    expect(await lock.acquire()).toEqual({ status: "unreadable", path: file });
    expect(readFileSync(file, "utf-8")).toBe("not-json");
  });

  it("does not create a recovery marker on the ordinary live-owner contention path", async () => {
    const dir = tempDir();
    const file = lockFile(dir);
    writeFileSync(file, JSON.stringify(owner(1234)));
    const lock = new MainTurnLock(join(dir, "session.json"), () => true);

    expect(await lock.acquire()).toEqual({ status: "busy", ownerPid: 1234 });
    expect(readdirSync(dir)).toEqual(["session.json.continue-lock"]);
  });

  it("reports a live reaper as busy without changing either lock", async () => {
    const dir = tempDir();
    const file = lockFile(dir);
    const recovery = `${file}.recovery`;
    writeFileSync(file, JSON.stringify(owner(1234)));
    writeFileSync(recovery, JSON.stringify(owner(5678)));
    const lock = new MainTurnLock(join(dir, "session.json"), pid => pid === 5678);

    expect(await lock.acquire()).toEqual({ status: "busy", ownerPid: 5678 });
    expect(JSON.parse(readFileSync(file, "utf-8")).pid).toBe(1234);
    expect(JSON.parse(readFileSync(recovery, "utf-8")).pid).toBe(5678);
  });

  it("reports a stale recovery marker with its path and leaves it for deliberate cleanup", async () => {
    const dir = tempDir();
    const file = lockFile(dir);
    const recovery = `${file}.recovery`;
    writeFileSync(file, JSON.stringify(owner(1234)));
    writeFileSync(recovery, JSON.stringify(owner(5678)));
    const lock = new MainTurnLock(join(dir, "session.json"), () => false);

    expect(await lock.acquire()).toEqual({ status: "unreadable", path: recovery });
    expect(existsSync(recovery)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf-8")).pid).toBe(1234);
  });

  it("fails closed when an owner record stays incomplete after the retry window", async () => {
    const dir = tempDir();
    const file = lockFile(dir);
    writeFileSync(file, "");
    const lock = new MainTurnLock(join(dir, "session.json"), () => false);

    expect(await lock.acquire()).toEqual({ status: "unreadable", path: file });
    expect(readdirSync(dir)).toEqual(["session.json.continue-lock"]);
  });

  it("does not release a replacement lock with a different activation token", async () => {
    const dir = tempDir();
    const file = lockFile(dir);
    const first = new MainTurnLock(join(dir, "session.json"));
    expect(await first.acquire()).toEqual({ status: "acquired" });

    writeFileSync(file, JSON.stringify(owner(process.pid, "replacement-token")));
    first.release();

    expect(JSON.parse(readFileSync(file, "utf-8")).token).toBe("replacement-token");
  });

  it("runs only after acquiring and releases the lock when the task returns false", async () => {
    const dir = tempDir();
    const path = join(dir, "session.json");
    const incumbent = new MainTurnLock(path);
    const contender = new MainTurnLock(path);
    expect(await incumbent.acquire()).toEqual({ status: "acquired" });
    let ran = false;

    const busy = await withMainTurnLock(contender, async () => {
      ran = true;
      return true;
    });
    expect(busy).toEqual({ status: "busy", ownerPid: process.pid });
    expect(ran).toBe(false);
    incumbent.release();

    const lock = new MainTurnLock(path);
    const completed = await withMainTurnLock(lock, async () => false);
    expect(completed).toEqual({ status: "completed", value: false });
    expect(existsSync(lockFile(dir))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("releases the lock when the continuation callback throws", async () => {
    const dir = tempDir();
    const lock = new MainTurnLock(join(dir, "session.json"));

    await expect(withMainTurnLock(lock, async () => {
      throw new Error("continuation failed");
    })).rejects.toThrow("continuation failed");

    expect(existsSync(lockFile(dir))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("does not invoke the callback for an unreadable owner record", async () => {
    const dir = tempDir();
    const file = lockFile(dir);
    writeFileSync(file, "");
    const lock = new MainTurnLock(join(dir, "session.json"), () => false);
    let ran = false;

    const result = await withMainTurnLock(lock, async () => {
      ran = true;
      return true;
    });

    expect(result).toEqual({ status: "unreadable", path: file });
    expect(ran).toBe(false);
    expect(readdirSync(dir)).toEqual(["session.json.continue-lock"]);
  });

  it("does not release a lock after its recorded PID changes", async () => {
    const dir = tempDir();
    const file = lockFile(dir);
    const lock = new MainTurnLock(join(dir, "session.json"));
    expect(await lock.acquire()).toEqual({ status: "acquired" });
    writeFileSync(file, JSON.stringify(owner(process.pid + 1)));

    lock.release();

    expect(JSON.parse(readFileSync(file, "utf-8")).pid).toBe(process.pid + 1);
  });

  it("keeps the lock for the full asynchronous continuation callback", async () => {
    const dir = tempDir();
    const file = lockFile(dir);
    const lock = new MainTurnLock(join(dir, "session.json"));
    let finish!: (value: boolean) => void;

    const running = withMainTurnLock(lock, () => new Promise<boolean>(resolve => { finish = resolve; }));
    expect(existsSync(file)).toBe(true);
    expect(await new MainTurnLock(join(dir, "session.json")).acquire()).toEqual({ status: "busy", ownerPid: process.pid });

    finish(true);
    expect(await running).toEqual({ status: "completed", value: true });
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("releases a partially acquired lock when acquisition reports an error", async () => {
    const dir = tempDir();
    const path = join(dir, "session.json");
    const owned = new MainTurnLock(path);
    expect(await owned.acquire()).toEqual({ status: "acquired" });
    const failing = {
      acquire: () => { throw new Error("recovery marker cleanup failed"); },
      release: () => owned.release(),
    } as unknown as MainTurnLock;
    let ran = false;

    await expect(withMainTurnLock(failing, async () => { ran = true; })).rejects.toThrow("recovery marker cleanup failed");

    expect(ran).toBe(false);
    expect(existsSync(lockFile(dir))).toBe(false);
  });

  it("retries a partially written owner record instead of reporting it unreadable", async () => {
    const dir = tempDir();
    const file = lockFile(dir);
    writeFileSync(file, "");
    const lock = new MainTurnLock(join(dir, "session.json"), pid => pid === 1234);

    const pending = lock.acquire();
    setTimeout(() => writeFileSync(file, JSON.stringify(owner(1234))), 5);

    expect(await pending).toEqual({ status: "busy", ownerPid: 1234 });
  });

  it("returns a completed result when the lock cannot be released after a successful run", async () => {
    const dir = tempDir();
    const lock = new MainTurnLock(join(dir, "session.json"));
    const release = vi.spyOn(lock, "release").mockImplementation(() => {
      throw new Error("EPERM: cannot unlink");
    });

    const result = await withMainTurnLock(lock, async () => true);

    expect(result).toMatchObject({ status: "completed", value: true });
    expect((result as { releaseError?: unknown }).releaseError).toBeInstanceOf(Error);
    release.mockRestore();
    lock.release();
  });

  it("throws an aggregate when the continuation and the release both fail", async () => {
    const dir = tempDir();
    const lock = new MainTurnLock(join(dir, "session.json"));
    const release = vi.spyOn(lock, "release").mockImplementation(() => {
      throw new Error("EPERM: cannot unlink");
    });

    await expect(withMainTurnLock(lock, async () => {
      throw new Error("continuation failed");
    })).rejects.toThrow(AggregateError);

    release.mockRestore();
    lock.release();
  });

  it("uses exclusive file creation and does not depend on hard-link support", async () => {
    const dir = tempDir();
    const file = lockFile(dir);
    const lock = new MainTurnLock(join(dir, "session.json"));

    expect(await lock.acquire()).toEqual({ status: "acquired" });
    expect(JSON.parse(readFileSync(file, "utf-8")).token).toBeTypeOf("string");
    lock.release();
  });
});


describe("processIsAlive", () => {
  it("returns false only when the operating system confirms the PID is absent", () => {
    const esrch = Object.assign(new Error("no such process"), { code: "ESRCH" });
    const eperm = Object.assign(new Error("permission denied"), { code: "EPERM" });

    expect(processIsAlive(123, () => { throw esrch; })).toBe(false);
    expect(processIsAlive(123, () => { throw eperm; })).toBe(true);
    expect(processIsAlive(0, () => { throw esrch; })).toBe(false);
  });

  it("uses the injected PID probe for liveness checks", () => {
    const calls: Array<[number, number]> = [];
    expect(processIsAlive(456, (pid, signal) => { calls.push([pid, signal]); })).toBe(true);
    expect(calls).toEqual([[456, 0]]);
  });
});

