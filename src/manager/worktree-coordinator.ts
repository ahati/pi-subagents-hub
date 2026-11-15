import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../types.js";
import {
  cleanupWorktree,
  createWorktree,
  getWorktreeTimeoutSeconds,
  isWorktreeIsolationEnabled,
  pruneWorktrees,
  type WorktreeCleanupResult,
  type WorktreeInfo,
} from "../worktree.js";

export interface WorktreeSetupResult {
  wt: WorktreeInfo;
  worktreeCwd: string;
}

export class WorktreeCoordinator {
  private readonly worktreeRepos = new Set<string>();

  get repos(): ReadonlySet<string> {
    return this.worktreeRepos;
  }

  async setup(
    pi: ExtensionAPI,
    baseCwd: string,
    id: string,
    customCwd?: string,
  ): Promise<WorktreeSetupResult | undefined> {
    if (!isWorktreeIsolationEnabled()) return undefined;
    const wt = await createWorktree(pi, baseCwd, id);
    if (!wt) {
      throw new Error(
        'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed ' +
        `(a large checkout can time out after ${getWorktreeTimeoutSeconds()}s; raise \`worktreeTimeoutSeconds\` in subagents.json). ` +
        'Initialize git and commit at least once, or omit `isolation`.',
      );
    }
    this.worktreeRepos.add(baseCwd);
    const worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
    return { wt, worktreeCwd };
  }

  async cleanup(
    pi: ExtensionAPI,
    baseCwd: string,
    record: AgentRecord,
    options: {
      description?: string;
      customCwd?: string;
      onBeforeWorktreeCleanup?: (path: string) => Promise<void>;
    },
  ): Promise<WorktreeCleanupResult | undefined> {
    if (!record.worktree) return undefined;
    if (options.onBeforeWorktreeCleanup) {
      try {
        await options.onBeforeWorktreeCleanup(record.worktree.path);
      } catch {
        // best-effort
      }
    }
    const description = options.description ?? record.description ?? "";
    const wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, description);
    record.worktreeResult = wtResult;
    if (wtResult.error) {
      // A preservation failure must not look like a completed run: the worktree
      // may be the only copy of the agent's work.
      const message = `Worktree cleanup failed: ${wtResult.error}\nAgent worktree remains at \`${wtResult.path}\` for recovery.`;
      record.status = "error";
      record.error = record.error ? `${record.error}\n${message}` : message;
    } else if (wtResult.hasChanges && wtResult.branch) {
      const repoNote = options.customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
      record.result =
        (record.result ?? "") +
        `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${options.customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
    } else if (wtResult.hasChanges && wtResult.path) {
      record.result = (record.result ?? "") +
        `\n\n---\nAutomatic preservation failed. Worktree retained at \`${wtResult.path}\` for manual recovery. Do not remove it until your changes are saved.`;
    }
    return wtResult;
  }

  pruneAll(pi?: ExtensionAPI, fallbackCwd = process.cwd()): void {
    if (!pi) return;
    const prune = (repo: string) => {
      pruneWorktrees(pi, repo).catch(() => {});
    };
    prune(fallbackCwd);
    for (const repo of this.worktreeRepos) prune(repo);
  }
}

