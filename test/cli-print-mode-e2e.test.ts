/**
 * cli-print-mode-e2e.test.ts — the real `pi` CLI, run the way a user runs it:
 * `pi -e <this repo's source> -p --subagents-workflow-file=x.js`, as a child
 * process.
 *
 * The in-process runner (`helpers/print-mode-runner.ts`) is an SDK host: it
 * disposes the session itself and never sees what pi's print mode writes to
 * stderr after `session_shutdown`. Work that settles after shutdown and touches
 * the dead session shows up only here — as `Extension error (…)` lines, a stale
 * ctx warning, or a crash with a non-zero exit.
 *
 * The prompt-less case needs no model: with no prompt, pi never calls one. It
 * runs against whichever pi the repo has installed, so CI's floor and latest
 * jobs cover both. The rest drive a real model and are opt-in (PI_E2E_LIVE=1),
 * using your local `pi` login; PI_PROVIDER + PI_MODEL pin the model.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("..", import.meta.url));
// The published package loads ./dist/index.js, but a test must exercise the
// source it sits next to, not whatever dist/ was last built — `-e <file>`
// transpiles the entry and its import graph, exactly as the packaged path does.
const PI_SRC = join(REPO, "src", "index.ts");
const PI_PKG = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent");
const PI_CLI = join(PI_PKG, JSON.parse(readFileSync(join(PI_PKG, "package.json"), "utf-8")).bin.pi);

const LIVE = /^(1|true|yes)$/i.test(process.env.PI_E2E_LIVE ?? "");

interface PiRun { code: number | null; stdout: string; stderr: string }

/**
 * Run the CLI with stdin closed; resolve with its exit code and output. By
 * default home and agent dir are throwaway; `env` overrides them.
 */
function runPi(args: string[], cwd: string, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<PiRun> {
  const { env = { HOME: cwd, PI_CODING_AGENT_DIR: join(cwd, "agent") }, timeoutMs = 25_000 } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PI_CLI, ...args], {
      cwd,
      env: { ...process.env, PI_E2E_LIVE: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    // A process that never exits is a failure, not a slow pass.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi did not exit within ${timeoutMs}ms:\n${stderr}`));
    }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** The lines this extension writes to stderr, under either of its prefixes. */
const ourLines = (stderr: string) => stderr.split("\n").filter(l => /^\[pi-subagents(-hub)?\]/.test(l));

describe("pi CLI, print mode", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("`pi -p --subagents-workflow-file=x.js` with no prompt stops the run and exits cleanly", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-cli-e2e-"));
    const script = join(dir, "busy.js");
    // Still running at shutdown, so session_shutdown has to stop it.
    writeFileSync(script, [
      'export const meta = { name: "busy", description: "runs until stopped" };',
      "let n = 0; for (let i = 0; i < 1e12; i++) n += i;",
      "return n;",
    ].join("\n"));

    const { code, stdout, stderr } = await runPi(["-e", PI_SRC, "-p", `--subagents-workflow-file=${script}`], dir);

    expect(code, stderr).toBe(0);
    expect(stdout).toBe("");
    // Nothing reached into the dead session. pi's own startup notices (pi 1.6
    // warns that the empty home has no models) are not ours to pin.
    expect(stderr).not.toMatch(/Extension error|stale|Unhandled|ERR_/i);
    // Exactly our two lines: the run started, and why it was stopped. The
    // report keeps the fork's hub prefix; the drain family keeps upstream's.
    expect(ourLines(stderr)).toEqual([
      "[pi-subagents-hub] Running workflow busy…",
      '[pi-subagents] --subagents-workflow-file under -p needs a prompt; workflow stopped. Example: pi -p --subagents-workflow-file=x.js "Report the result."',
    ]);
  }, 30_000);
});

// Opt-in real-model runs. Smoke tests: a live model decides how to call the
// tools, so each prompt names the call exactly and the assertions check robust
// invariants — the token the work produced reached the printed answer, pi
// exited 0, and nothing reached into a dead session on the way out.
const LIVE_TIMEOUT = 180_000;

describe.runIf(LIVE)("pi CLI, print mode (live model, opt-in)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /**
   * `pi -e <repo> -p <prompt>` against your login. The agent dir is a temp copy
   * holding only your credentials and default model: `-ne` keeps your installed
   * packages out of the main session, but subagent sessions load them from the
   * agent dir's settings, and one that misbehaves there would fail these runs.
   */
  async function livePi(prompt: string | undefined, extra: string[] = []): Promise<PiRun> {
    dir = mkdtempSync(join(tmpdir(), "pi-cli-live-"));
    const realAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);
    for (const file of ["auth.json", "models-store.json", "models.json"]) {
      if (existsSync(join(realAgentDir, file))) symlinkSync(join(realAgentDir, file), join(agentDir, file));
    }
    const settingsPath = join(realAgentDir, "settings.json");
    const real = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {};
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: real.defaultProvider,
      defaultModel: real.defaultModel,
      quietStartup: true,
    }));
    const model = process.env.PI_PROVIDER && process.env.PI_MODEL
      ? ["--provider", process.env.PI_PROVIDER, "--model", process.env.PI_MODEL]
      : [];
    const args = ["-ne", "--no-mcp", "-ns", "-np", "-nc", "--no-session", "-e", PI_SRC, ...model, ...extra, "-p"];
    return runPi(prompt === undefined ? args : [...args, prompt], dir, {
      env: { PI_CODING_AGENT_DIR: agentDir },
      timeoutMs: LIVE_TIMEOUT - 10_000,
    });
  }

  /** The shutdown bug class: work reaching into the session after pi disposed it. */
  function expectCleanExit(run: PiRun) {
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).not.toMatch(/Extension error|stale|Unhandled|ERR_/i);
  }

  it("BACKGROUND subagent: pi waits for it and prints the parent's reaction", async () => {
    const run = await livePi(
      "Use the Agent tool to spawn a general-purpose subagent with run_in_background: true. Its task: " +
        "'Run the bash command: sleep 8; echo BG_TOKEN_47. Reply with the echoed word.' " +
        "Do not wait for it and do not call get_subagent_result. After launching, reply with just: started. " +
        "When its result arrives, reply with the word it echoed.",
    );
    expectCleanExit(run);
    expect(run.stderr).toContain("Waiting for background work to finish");
    expect(run.stdout).toMatch(/BG_TOKEN_47/);
  }, LIVE_TIMEOUT);

  it("--subagents-workflow-file with a prompt: the workflow's result is printed", async () => {
    const flagDir = mkdtempSync(join(tmpdir(), "pi-cli-flag-"));
    const script = join(flagDir, "flow.js");
    writeFileSync(script, [
      'export const meta = { name: "live-flag", description: "one slow agent, then a return" };',
      'await agent("Run the bash command: sleep 8; echo OK. Reply with the echoed word.", { label: "step" });',
      'return "FLAG_TOKEN_73";',
    ].join("\n"));
    try {
      const run = await livePi(
        "A workflow is running. When its result arrives, reply with the value it returned.",
        [`--subagents-workflow-file=${script}`],
      );
      expectCleanExit(run);
      expect(run.stderr).toContain("Waiting for background work to finish");
      expect(run.stdout).toMatch(/FLAG_TOKEN_73/);
    } finally {
      rmSync(flagDir, { recursive: true, force: true });
    }
  }, LIVE_TIMEOUT);
});
