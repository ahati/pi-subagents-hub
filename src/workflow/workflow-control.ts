import type { WorkflowControl, WorkflowHost } from "./runtime-types.js";

export interface LiveAgent {
  agentId: string;
  started: boolean;
  intent?: "skip" | "retry";
  /** Wakes it out of a pause hold, so a skip does not wait for a resume. */
  wake?: () => void;
}

/**
 * Control manager: live-agent tracking, pause/resume gating, and park draining.
 */
export class WorkflowControlManager {
  private readonly liveAgents = new Map<number, LiveAgent>();
  private readonly pauseWaiters = new Set<() => void>();
  private paused = false;
  private draining = false;

  isPaused(): boolean {
    return this.paused || this.draining;
  }

  isDraining(): boolean {
    return this.draining;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.releasePause();
  }

  stopWhenIdle(onDrain: () => void): void {
    this.draining = true;
    onDrain();
  }

  releasePause(): void {
    for (const wake of [...this.pauseWaiters]) wake();
    this.pauseWaiters.clear();
  }

  /** Park here while the run is paused, so no new agent is started. */
  pauseGate(live: LiveAgent, shouldBail: () => boolean): Promise<void> {
    if (!this.isPaused() || shouldBail()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = () => {
        this.pauseWaiters.delete(wake);
        live.wake = undefined;
        resolve();
      };
      live.wake = wake;
      this.pauseWaiters.add(wake);
    });
  }

  register(index: number, agentId: string): LiveAgent {
    const live: LiveAgent = { agentId, started: false };
    this.liveAgents.set(index, live);
    return live;
  }

  unregister(index: number): void {
    this.liveAgents.delete(index);
  }

  get(index: number): LiveAgent | undefined {
    return this.liveAgents.get(index);
  }

  skip(index: number, abortAgent: (agentId: string) => void): boolean {
    const live = this.liveAgents.get(index);
    if (live === undefined || live.intent !== undefined) return false;
    live.intent = "skip";
    if (live.started) abortAgent(live.agentId);
    else live.wake?.();
    return true;
  }

  retry(index: number, abortAgent: (agentId: string) => void): boolean {
    const live = this.liveAgents.get(index);
    if (live === undefined || !live.started || live.intent !== undefined) return false;
    live.intent = "retry";
    abortAgent(live.agentId);
    return true;
  }

  bindControl(
    onControl: ((control: WorkflowControl) => void) | undefined,
    host: WorkflowHost,
    onStopWhenIdle: () => void,
  ): void {
    onControl?.({
      pause: () => this.pause(),
      resume: () => this.resume(),
      isPaused: () => this.isPaused(),
      stopWhenIdle: () => this.stopWhenIdle(onStopWhenIdle),
      skip: (index) => this.skip(index, (id) => host.abortAgent(id)),
      retry: (index) => this.retry(index, (id) => host.abortAgent(id)),
    });
  }
}
