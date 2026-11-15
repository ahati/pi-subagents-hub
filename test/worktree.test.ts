import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupWorktree,
  createWorktree,
  getWorktreeTimeoutSeconds,
  isWorktreeIsolationEnabled,
  pruneWorktrees,
  setWorktreeIsolationEnabled,
  setWorktreeTimeoutSeconds,
} from "../src/worktree.js";

/**
 * Minimal stand-in for pi.exec(): runs the command for real, and — like the
 * host's implementation — REPORTS failure in the result instead of rejecting.
 * The source has to read `code`/`killed` rather than rely on a throw, so a stub
 * that threw would hide the branch that matters.
 */
function mockPi(): ExtensionAPI {
  return {
    exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      try {
        const stdout = execFileSync(command, args, {
          cwd: options?.cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: options?.timeout,
        });
        return { stdout, stderr: "", code: 0, killed: false };
      } catch (err: any) {
        return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.status ?? 1, killed: false };
      }
    },
  } as unknown as ExtensionAPI;
}

/**
 * A pi whose exec answers one git subcommand with a canned failure result and
 * runs everything else for real. `match` sees the argv git is called with.
 */
function failingPi(match: (args: string[]) => boolean, failure: { code: number; killed: boolean }): ExtensionAPI {
  const real = mockPi();
  return {
    exec: vi.fn(async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      if (match(args)) return { stdout: "", stderr: "boom", ...failure };
      return real.exec(command, args, options);
    }),
  } as unknown as ExtensionAPI;
}

/**
 * Helper: create a temporary git repo with an initial commit.
 */
function initGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-test-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test repo");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("worktree", () => {
  let repoDir: string;
  let pi: ExtensionAPI;

  beforeEach(() => {
    repoDir = initGitRepo();
    pi = mockPi();
  });

  afterEach(async () => {
    setWorktreeTimeoutSeconds(30);
    // Clean up any lingering worktrees first, then remove repo
    try { await pruneWorktrees(pi, repoDir); } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe("createWorktree", () => {
    it("creates a worktree in tmpdir", async () => {
      const wt = await createWorktree(pi, repoDir, "test-id-1");
      expect(wt).toBeDefined();
      expect(existsSync(wt!.path)).toBe(true);
      expect(wt!.branch).toBe("pi-agent-test-id-1");
      expect(wt!.baseSha).toBe(execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim());

      // Verify it's a valid worktree with the repo's files
      expect(existsSync(join(wt!.path, "README.md"))).toBe(true);

      // Cleanup
      try { execFileSync("git", ["worktree", "remove", "--force", wt!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("returns undefined for non-git directory", async () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        const wt = await createWorktree(pi, nonGit, "test-id-2");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });

    it("returns undefined for git repo with no commits", async () => {
      const emptyRepo = mkdtempSync(join(tmpdir(), "pi-wt-empty-"));
      try {
        execFileSync("git", ["init"], { cwd: emptyRepo, stdio: "pipe" });
        const wt = await createWorktree(pi, emptyRepo, "no-commits");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(emptyRepo, { recursive: true, force: true });
      }
    });

    it("returns undefined when `git worktree add` reports a non-zero exit", async () => {
      // pi.exec resolves with a failure code instead of throwing, so a port that
      // only caught exceptions would hand back a worktree path that isn't there.
      const wt = await createWorktree(
        failingPi(args => args[0] === "worktree" && args[1] === "add", { code: 128, killed: false }),
        repoDir,
        "add-fails",
      );
      expect(wt).toBeUndefined();
    });

    it("returns undefined when a git call is killed by its timeout", async () => {
      // A killed process reports code 0 with killed: true — the one failure
      // shape that looks like success if only the exit code is checked.
      const wt = await createWorktree(
        failingPi(args => args[0] === "rev-parse" && args[1] === "HEAD", { code: 0, killed: true }),
        repoDir,
        "timed-out",
      );
      expect(wt).toBeUndefined();
    });

    it("passes the configured checkout timeout to git", async () => {
      setWorktreeTimeoutSeconds(120);
      const exec = vi.fn(mockPi().exec);
      const tracking = { exec } as unknown as ExtensionAPI;
      const wt = await createWorktree(tracking, repoDir, "timeout-config");
      try {
        expect(wt).toBeDefined();
        expect(exec).toHaveBeenCalledWith(
          "git",
          ["worktree", "add", "--detach", expect.any(String), "HEAD"],
          expect.objectContaining({ timeout: 120_000 }),
        );
      } finally {
        if (wt) {
          try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
        }
      }
    });

    it("removes a partially created worktree when the checkout times out", async () => {
      const baseDir = mkdtempSync(join(tmpdir(), "pi-wt-partial-"));
      const real = mockPi();
      const calls: string[][] = [];
      let partial: string | undefined;
      const tracking = {
        exec: vi.fn(async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
          calls.push(args);
          if (args[0] === "worktree" && args[1] === "add") {
            partial = args[3];
            // An unregistered partial directory: killed before the admin entry
            // was written, so `worktree remove` reports "is not a working tree".
            mkdirSync(partial, { recursive: true });
            writeFileSync(join(partial, "half-checkout.txt"), "partial");
            return { stdout: "", stderr: "", code: 0, killed: true };
          }
          return real.exec(command, args, options);
        }),
      } as unknown as ExtensionAPI;
      try {
        setWorktreeTimeoutSeconds(30);
        expect(await createWorktree(tracking, repoDir, "partial-timeout", baseDir)).toBeUndefined();
        expect(partial).toBeDefined();
        expect(existsSync(partial!)).toBe(false);
        expect(calls.some(args =>
          args[0] === "worktree" && args[1] === "remove" && args.filter(a => a === "--force").length === 2,
        )).toBe(true);
        expect(calls.some(args => args[0] === "worktree" && args[1] === "prune")).toBe(true);
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    });

    it("removes a registered half-created worktree with no repo-wide prune", async () => {
      const baseDir = mkdtempSync(join(tmpdir(), "pi-wt-registered-"));
      const real = mockPi();
      const calls: string[][] = [];
      let partial: string | undefined;
      const tracking = {
        exec: vi.fn(async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
          calls.push(args);
          if (args[0] === "worktree" && args[1] === "add") {
            // A killed add that DID register: the admin entry and the copied
            // directory both exist, so the scoped remove must handle both.
            partial = args[3];
            execFileSync("git", ["worktree", "add", "--detach", partial, "HEAD"], { cwd: repoDir, stdio: "pipe" });
            return { stdout: "", stderr: "", code: 0, killed: true };
          }
          return real.exec(command, args, options);
        }),
      } as unknown as ExtensionAPI;
      try {
        expect(await createWorktree(tracking, repoDir, "partial-registered", baseDir)).toBeUndefined();
        expect(partial).toBeDefined();
        expect(existsSync(partial!)).toBe(false);
        const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoDir, stdio: "pipe" }).toString();
        expect(list).not.toContain(partial!);
        expect(calls.some(args => args[0] === "worktree" && args[1] === "prune")).toBe(false);
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    });

    it("clamps a programmatic timeout to the documented range", () => {
      setWorktreeTimeoutSeconds(1);
      expect(getWorktreeTimeoutSeconds()).toBe(30);
      setWorktreeTimeoutSeconds(99_999);
      expect(getWorktreeTimeoutSeconds()).toBe(3600);
    });

    it("workPath equals path when created from the repo root", async () => {
      const wt = (await createWorktree(pi, repoDir, "root-wp"))!;
      expect(wt.workPath).toBe(wt.path);
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("workPath preserves subdirectory scoping (monorepo package cwd)", async () => {
      mkdirSync(join(repoDir, "packages", "api"), { recursive: true });
      writeFileSync(join(repoDir, "packages", "api", "index.ts"), "export {}");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "add package"], { cwd: repoDir, stdio: "pipe" });

      const wt = (await createWorktree(pi, join(repoDir, "packages", "api"), "subdir-wp"))!;
      expect(wt).toBeDefined();
      expect(wt.workPath).toBe(join(wt.path, "packages", "api"));
      expect(existsSync(wt.workPath)).toBe(true);
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("uses unique paths for multiple worktrees", async () => {
      const wt1 = await createWorktree(pi, repoDir, "multi-1");
      const wt2 = await createWorktree(pi, repoDir, "multi-2");
      expect(wt1).toBeDefined();
      expect(wt2).toBeDefined();
      expect(wt1!.path).not.toBe(wt2!.path);

      // Cleanup
      try { execFileSync("git", ["worktree", "remove", "--force", wt1!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      try { execFileSync("git", ["worktree", "remove", "--force", wt2!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("creates worktrees concurrently — the git calls do not serialize on one another", async () => {
      // The reason for the port: several isolated agents can start at once, so
      // no call may block the caller until the previous one has finished.
      const order: string[] = [];
      const tracking = {
        exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
          order.push(`start:${args[0]}`);
          const result = await pi.exec(command, args, options);
          order.push(`end:${args[0]}`);
          return result;
        },
      } as unknown as ExtensionAPI;

      const [a, b] = await Promise.all([
        createWorktree(tracking, repoDir, "par-1"),
        createWorktree(tracking, repoDir, "par-2"),
      ]);
      expect(a).toBeDefined();
      expect(b).toBeDefined();

      // Interleaving proves the two chains ran together: with blocking calls the
      // log would be strictly start/end paired.
      const interleaved = order.some((entry, i) => entry.startsWith("start:") && order[i + 1]?.startsWith("start:"));
      expect(interleaved).toBe(true);

      for (const wt of [a!, b!]) {
        try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      }
    });
  });

  describe("cleanupWorktree", () => {
    it("removes worktree when no changes made", async () => {
      const wt = (await createWorktree(pi, repoDir, "clean-1"))!;
      expect(wt).toBeDefined();

      const result = await cleanupWorktree(pi, repoDir, wt, "test cleanup");
      expect(result.hasChanges).toBe(false);
      expect(result.branch).toBeUndefined();
      expect(existsSync(wt.path)).toBe(false);
    });

    it("commits changes and creates branch when changes exist", async () => {
      const wt = (await createWorktree(pi, repoDir, "dirty-1"))!;
      expect(wt).toBeDefined();

      // Make a change in the worktree
      writeFileSync(join(wt.path, "new-file.txt"), "agent wrote this");

      const result = await cleanupWorktree(pi, repoDir, wt, "added new file");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBeDefined();
      expect(result.branch).toContain("pi-agent-dirty-1");

      // Verify the branch exists in the main repo
      const branches = execFileSync("git", ["branch", "--list", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branches).toContain(result.branch!);

      // Verify the commit message
      const log = execFileSync("git", ["log", "--oneline", "-1", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(log).toContain("pi-agent: added new file");

      // Cleanup branch
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("preserves new files when Git configuration hides untracked files", async () => {
      execFileSync("git", ["config", "status.showUntrackedFiles", "no"], { cwd: repoDir, stdio: "pipe" });
      const wt = (await createWorktree(pi, repoDir, "hidden-untracked"))!;
      try {
        writeFileSync(join(wt.path, "agent-output.txt"), "irreplaceable output");
        expect(execFileSync("git", ["status", "--porcelain"], {
          cwd: wt.path, encoding: "utf-8", stdio: "pipe",
        })).toBe("");

        const result = await cleanupWorktree(pi, repoDir, wt, "new file");

        expect(result.hasChanges).toBe(true);
        expect(result.branch).toBe("pi-agent-hidden-untracked");
        expect(execFileSync("git", ["show", `${result.branch}:agent-output.txt`], {
          cwd: repoDir, encoding: "utf-8", stdio: "pipe",
        })).toBe("irreplaceable output");
        expect(existsSync(wt.path)).toBe(false);
      } finally {
        rmSync(wt.path, { recursive: true, force: true });
      }
    });

    it("commits changes even when a pre-commit hook rejects (--no-verify)", async () => {
      // A failing pre-commit hook in the main repo also applies to its
      // worktrees — without --no-verify it would abort the preservation commit.
      const hookPath = join(repoDir, ".git", "hooks", "pre-commit");
      writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      const wt = (await createWorktree(pi, repoDir, "hooked-1"))!;
      expect(wt).toBeDefined();
      writeFileSync(join(wt.path, "hooked-file.txt"), "agent wrote this");

      const result = await cleanupWorktree(pi, repoDir, wt, "hook should not block");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBe("pi-agent-hooked-1");

      // Cleanup branch
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("creates branch when worktree is clean but HEAD moved", async () => {
      const wt = (await createWorktree(pi, repoDir, "committed-1"))!;
      expect(wt).toBeDefined();

      writeFileSync(join(wt.path, "committed-file.txt"), "agent committed this");
      execFileSync("git", ["add", "committed-file.txt"], { cwd: wt.path, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "agent commit"], { cwd: wt.path, stdio: "pipe" });
      const agentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: wt.path, stdio: "pipe",
      }).toString().trim();

      const result = await cleanupWorktree(pi, repoDir, wt, "already committed");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBeDefined();
      expect(result.branch).toBe("pi-agent-committed-1");

      const branchCommit = execFileSync("git", ["rev-parse", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branchCommit).toBe(agentCommit);
      expect(existsSync(wt.path)).toBe(false);

      // Cleanup branch
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("does not force-overwrite existing branch", async () => {
      // Create first worktree, make changes, cleanup → creates branch
      const wt1 = (await createWorktree(pi, repoDir, "conflict-1"))!;
      writeFileSync(join(wt1.path, "file1.txt"), "first run");
      const result1 = await cleanupWorktree(pi, repoDir, wt1, "first");
      expect(result1.branch).toBe("pi-agent-conflict-1");

      // Create second worktree with same agent ID, make changes
      const wt2 = (await createWorktree(pi, repoDir, "conflict-1"))!;
      writeFileSync(join(wt2.path, "file2.txt"), "second run");
      const result2 = await cleanupWorktree(pi, repoDir, wt2, "second");

      // Should use a different branch name (timestamp suffix)
      expect(result2.hasChanges).toBe(true);
      expect(result2.branch).toBeDefined();
      expect(result2.branch).not.toBe("pi-agent-conflict-1");
      expect(result2.branch).toContain("pi-agent-conflict-1-");

      // Both branches should exist
      const branches = execFileSync("git", ["branch", "--list", "pi-agent-conflict-1*"], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branches).toContain("pi-agent-conflict-1");
      expect(branches).toContain(result2.branch!);

      // Cleanup
      try { execFileSync("git", ["branch", "-D", result1.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      try { execFileSync("git", ["branch", "-D", result2.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("handles already-deleted worktree gracefully", async () => {
      const wt = (await createWorktree(pi, repoDir, "gone-1"))!;
      // Manually delete the worktree directory
      rmSync(wt.path, { recursive: true, force: true });

      const result = await cleanupWorktree(pi, repoDir, wt, "already gone");
      expect(result.hasChanges).toBe(false);
    });

    it("truncates commit message at 200 chars", async () => {
      const wt = (await createWorktree(pi, repoDir, "long-msg"))!;
      writeFileSync(join(wt.path, "change.txt"), "something");
      const longDesc = "x".repeat(300);
      const result = await cleanupWorktree(pi, repoDir, wt, longDesc);
      expect(result.hasChanges).toBe(true);

      const log = execFileSync("git", ["log", "--oneline", "-1", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      // "pi-agent: " prefix (10 chars) + 200 chars of x = 210 total max
      expect(log.length).toBeLessThanOrEqual(220); // some slack for hash prefix

      // Cleanup
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("reports the recovery path when clean worktree removal fails", async () => {
      const wt = (await createWorktree(pi, repoDir, "remove-fails"))!;
      const failing = failingPi(
        args => args[0] === "worktree" && args[1] === "remove",
        { code: 1, killed: false },
      );

      try {
        const result = await cleanupWorktree(failing, repoDir, wt, "removal fails");

        expect(result).toEqual({ hasChanges: true, path: wt.path, error: "boom" });
        expect(existsSync(wt.path)).toBe(true);
        expect(vi.mocked(failing.exec).mock.calls.some(([, args]) => args[0] === "worktree" && args[1] === "prune")).toBe(true);
      } finally {
        try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      }
    });

    it("keeps branch metadata when removal fails after preserving changes", async () => {
      const wt = (await createWorktree(pi, repoDir, "dirty-remove-fails"))!;
      writeFileSync(join(wt.path, "work.txt"), "agent output");
      const failing = failingPi(
        args => args[0] === "worktree" && args[1] === "remove",
        { code: 1, killed: false },
      );

      try {
        const result = await cleanupWorktree(failing, repoDir, wt, "removal fails");

        expect(result).toEqual({
          hasChanges: true,
          branch: wt.branch,
          path: wt.path,
          error: "boom",
        });
        expect(existsSync(wt.path)).toBe(true);
        expect(execFileSync("git", ["branch", "--list", wt.branch], { cwd: repoDir, encoding: "utf8" })).toContain(wt.branch);
      } finally {
        try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
        try { execFileSync("git", ["branch", "-D", wt.branch], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      }
    });

    it("bypasses configured commit signing for preservation commits", async () => {
      const isWindows = platform() === "win32";
      const signerMarker = join(repoDir, "signer-invoked");
      const signerPath = join(repoDir, isWindows ? "signer.cmd" : "signer.sh");
      writeFileSync(
        signerPath,
        isWindows
          ? `@echo invoked>"${signerMarker}"\r\nexit /b 1\r\n`
          : `#!/bin/sh\nprintf invoked > "${signerMarker}"\nexit 1\n`,
        { mode: 0o755 },
      );
      for (const [key, value] of [
        ["commit.gpgsign", "true"],
        ["gpg.format", "ssh"],
        ["gpg.ssh.program", signerPath],
        ["user.signingkey", "test-signing-key"],
      ]) {
        execFileSync("git", ["config", key, value], { cwd: repoDir, stdio: "pipe" });
      }

      const wt = (await createWorktree(pi, repoDir, "signed-1"))!;
      writeFileSync(join(wt.path, "signed-file.txt"), "agent wrote this");

      try {
        const result = await cleanupWorktree(pi, repoDir, wt, "signing must not block");

        expect(result.hasChanges).toBe(true);
        expect(result.branch).toBe("pi-agent-signed-1");
        expect(existsSync(signerMarker)).toBe(false);
      } finally {
        try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
        try { execFileSync("git", ["branch", "-D", wt.branch], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      }
    });
  });

  describe("pruneWorktrees", () => {
    it("does not reject on a clean repo", async () => {
      await expect(pruneWorktrees(pi, repoDir)).resolves.toBeUndefined();
    });

    it("does not reject on non-git directory", async () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        await expect(pruneWorktrees(pi, nonGit)).resolves.toBeUndefined();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });
  });
});

// Cleanup failures must keep the worktree recoverable rather than deleting
// files or detached commits that have not reached a preservation branch.
// The result must name that retained path instead of claiming no changes.
describe("cleanupWorktree — failure path", () => {
  let repoDir: string;
  let pi: ExtensionAPI;

  beforeEach(() => { repoDir = initGitRepo(); pi = mockPi(); });
  afterEach(async () => {
    try { await pruneWorktrees(pi, repoDir); } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("short-circuits when the worktree directory is already gone", async () => {
    // Hits the existsSync guard at the top of cleanupWorktree, not the outer
    // catch — cleanup can be called twice (settle path plus dispose), so it has
    // to be idempotent rather than throw on the second call.
    const wt = (await createWorktree(pi, repoDir, "vanished"))!;
    expect(wt).toBeDefined();
    rmSync(wt.path, { recursive: true, force: true });

    const result = await cleanupWorktree(pi, repoDir, wt, "agent that vanished");

    expect(result.hasChanges).toBe(false);
    expect(result.branch).toBeUndefined();
  });

  it("keeps a corrupted worktree and reports its recovery path", async () => {
    // A broken .git file prevents preservation, but the output still exists
    // and must remain available for manual recovery.
    const baseDir = mkdtempSync(join(tmpdir(), "pi-wt-corrupt-"));
    try {
      const wt = (await createWorktree(pi, repoDir, "corrupt", baseDir))!;
      writeFileSync(join(wt.path, "work.txt"), "agent output");
      // Break the worktree's link back to the repo.
      writeFileSync(join(wt.path, ".git"), "gitdir: /nonexistent/path/that/is/not/a/repo");

      const result = await cleanupWorktree(pi, repoDir, wt, "corrupted agent");

      expect(result).toEqual({ hasChanges: true, path: wt.path, error: expect.any(String) });
      expect(readFileSync(join(wt.path, "work.txt"), "utf-8")).toBe("agent output");
      // The corruption defeats cleanup on purpose, so the directory is still
      // there — the reason this test disposes of it itself. Created under its
      // own base dir, that leaves nothing behind in the system temp dir.
      expect(existsSync(wt.path)).toBe(true);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it.each(["status", "add", "commit", "branch"])("preserves files when git %s fails", async command => {
    const baseDir = mkdtempSync(join(tmpdir(), "pi-wt-preserve-"));
    try {
      const wt = (await createWorktree(pi, repoDir, `${command}-fails`, baseDir))!;
      writeFileSync(join(wt.path, "work.txt"), "agent output");
      const failing = failingPi(args => args[0] === command, { code: 1, killed: false });

      const result = await cleanupWorktree(failing, repoDir, wt, `${command} fails`);

      // Check the actual artifact first: the old catch forcibly removed it.
      expect(existsSync(wt.path)).toBe(true);
      expect(readFileSync(join(wt.path, "work.txt"), "utf-8")).toBe("agent output");
      expect(result).toEqual({ hasChanges: true, path: wt.path, error: expect.any(String) });
      expect(vi.mocked(failing.exec).mock.calls.some(([, args]) =>
        args[0] === "worktree" && args[1] === "remove")).toBe(false);
      expect(execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repoDir, encoding: "utf-8", stdio: "pipe",
      })).toContain(wt.path);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("creates the branch BEFORE removing the worktree, so a removal failure cannot lose commits", async () => {
    // Ordering is the actual safety property. If a refactor moved
    // removeWorktree above the `git branch` call, the commits would be
    // unreachable the moment removal succeeded and branching failed.
    const wt = (await createWorktree(pi, repoDir, "ordered"))!;
    writeFileSync(join(wt.path, "work.txt"), "agent output");

    const result = await cleanupWorktree(pi, repoDir, wt, "ordered agent");

    expect(result.hasChanges).toBe(true);
    expect(result.branch).toBeDefined();
    // The branch must exist in the MAIN repo after the worktree is gone —
    // that is what makes the agent's work recoverable.
    const branches = execFileSync("git", ["branch", "--list", result.branch!], {
      cwd: repoDir, stdio: "pipe",
    }).toString();
    expect(branches).toContain(result.branch!);
    expect(existsSync(wt.path)).toBe(false);
    // And the commit is reachable from that branch.
    const files = execFileSync("git", ["ls-tree", "--name-only", result.branch!], {
      cwd: repoDir, stdio: "pipe",
    }).toString();
    expect(files).toContain("work.txt");
  });
});

/**
 * The project switch itself (`worktreeIsolation`, #184). Its consumers —
 * agent-manager, both tool schemas, the invocation resolver — all mock this
 * module, so without this block the real singleton is never executed and its
 * default is never exercised. That default is what every "worktree isolation
 * still behaves as before" claim rests on.
 */
describe("worktree isolation switch", () => {
  afterEach(() => setWorktreeIsolationEnabled(true));

  it("defaults to enabled", () => {
    expect(isWorktreeIsolationEnabled()).toBe(true);
  });

  it("round-trips both ways", () => {
    setWorktreeIsolationEnabled(false);
    expect(isWorktreeIsolationEnabled()).toBe(false);
    setWorktreeIsolationEnabled(true);
    expect(isWorktreeIsolationEnabled()).toBe(true);
  });

  // The switch gates callers; it deliberately does not disarm createWorktree
  // itself, so a caller that has already decided (agent-manager checks first)
  // still gets a real worktree rather than a silent no-op.
  it("does not disable createWorktree directly", async () => {
    const repoDir = initGitRepo();
    const pi = mockPi();
    try {
      setWorktreeIsolationEnabled(false);
      const wt = await createWorktree(pi, repoDir, "switch-test");
      expect(wt).toBeDefined();
      expect(existsSync(wt!.path)).toBe(true);
      await cleanupWorktree(pi, repoDir, wt!, "switch test");
    } finally {
      await pruneWorktrees(pi, repoDir).catch(() => {});
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
