/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of the repo.
 * On completion, if no changes were made, the worktree is cleaned up.
 * If changes exist, a branch is created and returned in the result.
 *
 * Every git call goes through `pi.exec` (async) rather than `execFileSync`: a
 * worktree copy can take seconds, and a session that spawns several isolated
 * agents at once would otherwise serialize them all on the TUI's event loop.
 */

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Branch name created for this worktree (if changes exist). */
  branch: string;
  /** Commit SHA that the worktree was created from. */
  baseSha: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was the
   * repo root; points at the copied subdirectory when it was deeper (e.g. a
   * monorepo package), so the requested scoping survives isolation.
   */
  workPath: string;
}

/**
 * Project-wide switch for worktree isolation (`worktreeIsolation` in
 * subagents.json). Default `true` — unchanged behaviour.
 *
 * The `"off"` isolation value gives a model a legal way to decline a worktree,
 * but it still depends on the model choosing it. This is the deterministic half
 * of the same fix: on a large repo where every worktree costs real time and
 * disk (#184), turning it off means no caller can create one, whatever it
 * passes.
 */
let worktreeIsolationEnabled = true;

export function setWorktreeIsolationEnabled(enabled: boolean): void {
  worktreeIsolationEnabled = enabled;
}

export function isWorktreeIsolationEnabled(): boolean {
  return worktreeIsolationEnabled;
}

export const MIN_WORKTREE_TIMEOUT_SECONDS = 30;
export const MAX_WORKTREE_TIMEOUT_SECONDS = 3600;
const DEFAULT_WORKTREE_TIMEOUT_SECONDS = 30;

/**
 * How long `git worktree add` may take, in seconds. Default 30 — the value this
 * was hardcoded to before it became a setting.
 *
 * A large repository can take minutes to check out, and the failure used to be
 * indistinguishable from "not a git repo": the spawn dies with a message that
 * sends the reader to initialize git. Raising this is the whole fix for that
 * case; it is a project setting rather than a per-call option because the
 * repository size is the thing that decides it.
 */
let worktreeTimeoutSeconds = DEFAULT_WORKTREE_TIMEOUT_SECONDS;

export function getWorktreeTimeoutSeconds(): number {
  return worktreeTimeoutSeconds;
}

export function setWorktreeTimeoutSeconds(seconds: number): void {
  if (!Number.isInteger(seconds)) return;
  worktreeTimeoutSeconds = Math.min(MAX_WORKTREE_TIMEOUT_SECONDS, Math.max(MIN_WORKTREE_TIMEOUT_SECONDS, seconds));
}

export interface WorktreeCleanupResult {
  /** Whether changes were found, or preservation failed and the worktree was kept for recovery. */
  hasChanges: boolean;
  /** Branch name if changes were committed. */
  branch?: string;
  /** Worktree path. On error, the agent's changes remain here for recovery. */
  path?: string;
  /** Cleanup failure. When present, the worktree is deliberately preserved. */
  error?: string;
}

/**
 * Run git and return its trimmed stdout, throwing on failure so callers keep
 * the try/catch control flow `execFileSync` gave them.
 *
 * `pi.exec` never rejects — it reports failure in the result — and a command
 * killed by its timeout comes back as `killed` with an exit code of 0, so both
 * have to be checked to reproduce `execFileSync`'s "throws on anything but a
 * clean exit".
 */
async function git(pi: ExtensionAPI, cwd: string, args: string[], timeout: number): Promise<string> {
  const result = await pi.exec("git", args, { cwd, timeout });
  // A killed command reports exit code 0, so it has to be checked first — the
  // old single check turned every timeout into "exit 0", which read as success.
  if (result.killed) {
    throw new Error(`git ${args[0]} timed out after ${Math.round(timeout / 1000)}s`);
  }
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed (exit ${result.code})`);
  }
  return result.stdout.trim();
}

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree path, or undefined if not in a git repo.
 */
export async function createWorktree(
  pi: ExtensionAPI,
  cwd: string,
  agentId: string,
  /**
   * Directory the worktree is created under. Defaults to the OS temp dir;
   * tests pass their own so a worktree that is deliberately made
   * unremovable can still be disposed of as a unit.
   */
  baseDir: string = tmpdir(),
): Promise<WorktreeInfo | undefined> {
  // Verify we're in a git repo with at least one commit (HEAD must exist)
  let baseSha: string;
  let subdir: string;
  try {
    await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"], 5000);
    baseSha = await git(pi, cwd, ["rev-parse", "HEAD"], 5000);
    // Where cwd sits inside the repo ("" at the root): the agent must work at
    // the same subdirectory inside the copy, or a monorepo-package cwd would
    // silently widen to the whole repo. realpath both sides — git emits
    // resolved paths while cwd may arrive through a symlink (macOS /tmp).
    const topLevel = await git(pi, cwd, ["rev-parse", "--show-toplevel"], 5000);
    subdir = relative(realpathSync(topLevel), realpathSync(cwd));
  } catch {
    return undefined;
  }

  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(baseDir, `pi-agent-${agentId}-${suffix}`);

  try {
    // Create detached worktree at HEAD
    await git(pi, cwd, ["worktree", "add", "--detach", worktreePath, "HEAD"], worktreeTimeoutSeconds * 1000);
    return { path: worktreePath, branch, baseSha, workPath: subdir ? join(worktreePath, subdir) : worktreePath };
  } catch {
    // A killed `worktree add` can leave a half-populated directory and a
    // registration behind. Drop both before reporting failure; otherwise a
    // timed-out attempt leaks a copy of the repository into the temp dir and
    // makes the next `git worktree add` for that path fail too.
    await discardWorktree(pi, cwd, worktreePath);
    // If worktree creation fails, return undefined (agent runs in normal cwd)
    return undefined;
  }
}

/**
 * Best-effort removal of a worktree that failed to finish creating.
 *
 * `git worktree remove --force --force` is the exact-worktree operation: it
 * deletes the working directory and its `.git/worktrees/<name>` entry in one
 * scoped call, so no repository-wide prune is needed on the normal path. The
 * second `--force` also clears a lock a killed `worktree add` can leave, and
 * the command succeeds when the directory is already gone but the
 * registration remains — which is why there is no `existsSync` guard.
 *
 * A failed add can also leave a directory that was never registered, removed
 * before the admin entry was written. There `worktree remove` reports "is not a
 * working tree"; delete that exact path, then prune the orphaned metadata.
 * Prune only drops registrations whose directory is missing, so another
 * agent's live worktree is untouched.
 *
 * Never throws: this runs on a path that is already reporting a failure, and
 * the caller's job is to fail the spawn cleanly, not to surface a second
 * cleanup error it can do nothing about.
 */
async function discardWorktree(pi: ExtensionAPI, cwd: string, worktreePath: string): Promise<void> {
  try {
    await git(pi, cwd, ["worktree", "remove", "--force", "--force", worktreePath], 10000);
    return;
  } catch { /* not registered, or the admin entry itself is corrupt */ }
  // Asynchronous: a large partial checkout must not block the event loop that
  // every other running workflow shares.
  try {
    await rm(worktreePath, { recursive: true, force: true });
  } catch { /* ignore */ }
  try {
    await git(pi, cwd, ["worktree", "prune"], 5000);
  } catch { /* ignore */ }
}

/**
 * Clean up a worktree after agent completion.
 * - If no changes: remove worktree entirely.
 * - If changes exist: create a branch, commit changes, return branch info.
 */
export async function cleanupWorktree(
  pi: ExtensionAPI,
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): Promise<WorktreeCleanupResult> {
  if (!existsSync(worktree.path)) {
    return { hasChanges: false };
  }

  let preservedBranch: string | undefined;
  try {
    // Check for uncommitted changes in the worktree
    const status = await git(pi, worktree.path, ["status", "--porcelain", "--untracked-files=all"], 10000);

    if (status) {
      // Changes exist — stage, commit, and create a branch
      await git(pi, worktree.path, ["add", "-A"], 10000);
      // Truncate description for commit message (no shell sanitization needed — pi.exec uses argv)
      const safeDesc = agentDescription.slice(0, 200);
      const commitMsg = `pi-agent: ${safeDesc}`;
      await git(pi, worktree.path, ["commit", "--no-verify", "--no-gpg-sign", "-m", commitMsg], 10000);
    } else {
      const currentSha = await git(pi, worktree.path, ["rev-parse", "HEAD"], 5000);

      if (currentSha === worktree.baseSha) {
        // No changes — remove worktree
        await removeWorktree(pi, cwd, worktree.path);
        return { hasChanges: false };
      }
    }

    // Create a branch pointing to the worktree's HEAD.
    // If the branch already exists, append a suffix to avoid overwriting previous work.
    let branchName = worktree.branch;
    try {
      await git(pi, worktree.path, ["branch", branchName], 5000);
    } catch {
      // Branch already exists — use a unique suffix
      branchName = `${worktree.branch}-${Date.now()}`;
      await git(pi, worktree.path, ["branch", branchName], 5000);
    }
    // Update branch name in worktree info for the caller
    worktree.branch = branchName;
    preservedBranch = branchName;

    // Remove the worktree (branch persists in main repo)
    await removeWorktree(pi, cwd, worktree.path);

    return {
      hasChanges: true,
      branch: worktree.branch,
      path: worktree.path,
    };
  } catch (error) {
    // This may be the only copy of the agent's work. Keep it recoverable and
    // report the path instead of turning a preservation failure into "no changes".
    return {
      hasChanges: true,
      ...(preservedBranch ? { branch: preservedBranch } : {}),
      path: worktree.path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Force-remove a worktree.
 */
async function removeWorktree(pi: ExtensionAPI, cwd: string, worktreePath: string): Promise<void> {
  try {
    await git(pi, cwd, ["worktree", "remove", "--force", worktreePath], 10000);
  } catch (removeError) {
    // A concurrent remover may have deleted the directory while Git still
    // returned an error. Prune stale metadata, but report failure if the copy
    // still exists — callers must not mistake a leaked worktree for success.
    try {
      await git(pi, cwd, ["worktree", "prune"], 5000);
    } catch { /* ignore */ }
    if (existsSync(worktreePath)) throw removeError;
  }
}

/**
 * Prune any orphaned worktrees (crash recovery).
 */
export async function pruneWorktrees(pi: ExtensionAPI, cwd: string): Promise<void> {
  try {
    await git(pi, cwd, ["worktree", "prune"], 5000);
  } catch { /* ignore */ }
}
