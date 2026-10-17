/**
 * runtime.ts — the host half of a workflow run.
 *
 * Owns the worker lifecycle, the RPC bridge, the concurrency semaphore, the
 * per-run caps, and the progress log. The script's only route to an agent is a
 * `call` message landing here, which is what makes the caps and the abort story
 * enforceable at all: a script cannot go around them because it has nothing to
 * go around them *with*.
 *
 * Spawning is injected rather than imported. `AgentManager` is a large, stateful
 * dependency and wiring it in directly would make every test here an integration
 * test; a {@link WorkflowHost} stub is a dozen lines. The adapter that binds this
 * to the real manager lives at the call site.
 */

import { Worker } from "node:worker_threads";
import {
  type JournalKeyInput,
  journalKey,
  type WorkflowJournalEntry,
  type WorkflowJournalGate,
} from "./journal.js";
import { type CompiledSchema, compileJsonSchema } from "./json-schema.js";
import type { WorkflowAgentEntry, WorkflowEntry } from "./progress.js";
import {
  type RunWorkflowOptions,
  WORKFLOW_AGENT_CAP,
  WORKFLOW_ITEM_CAP,
  WORKFLOW_NESTED_CAP,
  WORKFLOW_PARK_STOP_ERROR,
  type WorkflowRunResult,
  type WorkflowScriptRef,
  type WorkflowScriptSource,
  type WorkflowSpawnResult,
  workflowConcurrency,
} from "./runtime-types.js";
import { WORKER_SOURCE } from "./worker-source.js";

export * from "./boundary.js";
export * from "./runtime-types.js";
export * from "./script-validator.js";

import { assertBoundarySafe } from "./boundary.js";
import { validateScript } from "./script-validator.js";
import { Semaphore } from "./semaphore.js";
import {
  type AgentCallPayload,
  applyGate,
  applySchema,
  type CompletedChild,
  derivedLabel,
  preview,
  unawaitedLaunchMessage,
  type WorkerMessage,
} from "./workflow-gate.js";

export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const { script, host } = options;

  assertBoundarySafe(options.args, "args");

  const { meta, body } = validateScript(script);
  const agentCap = options.agentCap ?? WORKFLOW_AGENT_CAP;
  const itemCap = options.itemCap ?? WORKFLOW_ITEM_CAP;
  const semaphore = new Semaphore(options.concurrency ?? workflowConcurrency());

  const progress: WorkflowEntry[] = [];
  const inflight = new Set<string>();
  /** Label → the child that ran under it, last one wins. The `resume` handle. */
  const completedByLabel = new Map<string, CompletedChild>();
  /**
   * Launches the host has accepted and not yet answered, in call order.
   *
   * This is the whole unawaited-launch mechanism: a script that drops an
   * `agent()` promise still gets its call answered eventually, but it returns
   * first — so anything left here when `complete` arrives is a result nobody is
   * waiting for. Tracking it host-side avoids proxying `Promise` inside the
   * realm, which §2.4 rules out, and reading stack traces, which is brittle.
   */
  const openLaunches = new Map<number, string>();
  let agentCount = 0;
  let aborted = false;
  let settled = false;

  /* --- resume state ---------------------------------------------------- */

  const journalEntries = options.journal?.entries ?? [];
  const recordJournal = options.journal?.append;
  /**
   * Whether the replayable prefix is still intact.
   *
   * Once a position misses — different key, a journaled failure, or nothing
   * recorded there — every later call runs live, however well it matches.
   * See the header of journal.ts for why this is a prefix and not a lookup.
   */
  // A journal from a run that used `agent({ resume })` is declined whole: see
  // journal.ts on why a replayed agent leaves nothing for a later resume to
  // continue. Declining up front beats stranding the first `resume` call
  // partway through a run that has already spent its cheap half.
  const journalResumes = journalEntries.some(entry => entry.resumed);
  let prefixIntact = journalEntries.length > 0 && !journalResumes;
  let replayedCount = 0;

  /* --- live control ---------------------------------------------------- */

  /**
   * Agents that still have an unanswered `agent()` call, by index.
   *
   * The window in which skip and retry mean anything: before the entry appears
   * there is nothing to act on, and after it is gone the script already has its
   * value. `started` is what separates the two — a retry needs a child to stop.
   */
  interface LiveAgent {
    agentId: string;
    started: boolean;
    intent?: "skip" | "retry";
    /** Wakes it out of a pause hold, so a skip does not wait for a resume. */
    wake?: () => void;
  }
  const liveAgents = new Map<number, LiveAgent>();

  /**
   * Output tokens this run has spent, mirrored to the script as
   * `budget.spent()`.
   *
   * The host owns the number and every response carries it, rather than the
   * worker accumulating its own: two counters would drift, and there is nothing
   * to gain from the second one. Nor is there observable staleness — tokens
   * only accrue through agents, and the script only learns anything through
   * agent responses.
   */
  let spentOutputTokens = 0;

  let paused = false;
  /**
   * Set by {@link WorkflowControl.stopWhenIdle} and never cleared: a parked run
   * stays parked, whatever the dialog's `resume()` does next.
   */
  let draining = false;
  /** Read through a call for the same reason `intent()` is — see below. */
  const isPaused = () => paused || draining;
  /**
   * End the run once a park stop has nothing left in flight. Assigned inside
   * the run promise, where `finish` exists; the control surface only calls it
   * after that.
   */
  let maybeFinishDrain = (): void => {};
  const pauseWaiters = new Set<() => void>();
  /** Release everyone held at a pause — on resume, and on the way out. */
  function releasePause(): void {
    for (const wake of [...pauseWaiters]) wake();
    pauseWaiters.clear();
  }
  /** Park here while the run is paused, so no new agent is started. */
  function pauseGate(live: LiveAgent): Promise<void> {
    // `isPaused()` rather than `paused`: a draining run still parks at the gate.
    // If it returned immediately, a call that already held a permit would spin
    // through `release(); continue;` until the last in-flight agent settled.
    if (!isPaused() || aborted || settled) return Promise.resolve();
    return new Promise<void>(resolve => {
      const wake = () => {
        pauseWaiters.delete(wake);
        live.wake = undefined;
        resolve();
      };
      live.wake = wake;
      pauseWaiters.add(wake);
    });
  }

  options.onControl?.({
    pause: () => { paused = true; },
    resume: () => { paused = false; releasePause(); },
    isPaused: () => isPaused(),
    stopWhenIdle: () => {
      draining = true;
      // Not `releasePause()`: a woken caller that is still parked behind the
      // park sees `settled` and bails at the acquire check, and waking them
      // here would only race the finish below.
      maybeFinishDrain();
    },
    skip: index => {
      const live = liveAgents.get(index);
      if (live === undefined || live.intent !== undefined) return false;
      live.intent = "skip";
      // A running child is stopped, which comes back as a skipped result; a
      // held one is woken so it can bail at the gate it is parked on.
      if (live.started) host.abortAgent(live.agentId);
      else live.wake?.();
      return true;
    },
    retry: index => {
      const live = liveAgents.get(index);
      if (live === undefined || !live.started || live.intent !== undefined) return false;
      live.intent = "retry";
      host.abortAgent(live.agentId);
      return true;
    },
  });

  /** The journal entry to reuse at `index`, or undefined to run it live. */
  function replayAt(index: number, key: string): WorkflowJournalEntry | undefined {
    if (!prefixIntact) return undefined;
    const entry = journalEntries[index];
    if (entry === undefined || entry.index !== index || entry.key !== key || !entry.ok) {
      prefixIntact = false;
      return undefined;
    }
    return entry;
  }

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      body,
      metaJson: JSON.stringify(meta),
      argsJson: options.args === undefined ? undefined : JSON.stringify(options.args),
      itemCap,
      nestedCap: options.nestedCap ?? WORKFLOW_NESTED_CAP,
    },
  });

  return await new Promise<WorkflowRunResult>(resolve => {
    const emit = (entries: WorkflowEntry[]) => {
      if (entries.length === 0) return;
      progress.push(...entries);
      options.onProgress?.(entries);
    };

    const respond = (callId: number, ok: boolean, value?: unknown, error?: string, fatal?: boolean) => {
      // Cleared before the settled check: a launch answered by a run that is
      // already finishing is not an unawaited launch either.
      openLaunches.delete(callId);
      if (settled) return;
      // `spent` rides on every response, so the worker's `budget.spent()` is a
      // mirror of this number rather than a second tally of its own.
      worker.postMessage({ type: "response", callId, ok, value, error, fatal, spent: spentOutputTokens });
    };

    const finish = (result: Omit<WorkflowRunResult, "meta" | "progress" | "agentCount" | "replayedCount">) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      // Symmetric with `semaphore.drain()` below: everything parked is woken so
      // it observes the settle and unwinds. Nothing depends on it — the run's
      // promise resolves either way — it just does not leave live-agent
      // bookkeeping behind for a run that is over.
      releasePause();
      for (const agentId of inflight) host.abortAgent(agentId);
      inflight.clear();
      semaphore.drain();
      // Resolve only once the thread is actually down, so a caller that awaits
      // runWorkflow() is guaranteed not to be leaking one.
      const settle = () => resolve({ ...result, meta, progress, agentCount, replayedCount });
      void worker.terminate().then(settle, settle);
    };

    function onAbort() {
      aborted = true;
      // terminate() is why this runs in a worker at all: it stops a script that
      // is spinning or wedged mid-await, which an in-process vm cannot do.
      finish({ status: "killed", error: "Workflow aborted." });
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    maybeFinishDrain = () => {
      if (!draining || settled || inflight.size > 0) return;
      finish({ status: "killed", error: WORKFLOW_PARK_STOP_ERROR });
    };

    async function handleAgent(callId: number, payload: AgentCallPayload): Promise<void> {
      // Bound now: the optional methods are checked once, up front, so a
      // capability the host lacks fails before an agent is spawned rather than
      // after — a gate that never ran must not be mistaken for a gate that
      // passed.
      const runGate = host.runGate?.bind(host);
      const resumeAgent = host.resumeAgent?.bind(host);
      if (payload.gate !== undefined && runGate === undefined) {
        respond(callId, false, undefined, "This workflow host cannot run gate commands.", true);
        return;
      }
      if (payload.resume !== undefined && resumeAgent === undefined) {
        respond(callId, false, undefined, "This workflow host cannot resume agents.", true);
        return;
      }

      let resumed: CompletedChild | undefined;
      if (payload.resume !== undefined) {
        resumed = completedByLabel.get(payload.resume);
        if (resumed === undefined) {
          const known = [...completedByLabel.keys()];
          // Fatal: a typo'd label is a script bug, and folding it into a null
          // would show up as an agent that mysteriously returned nothing.
          //
          // Unless agents were replayed, in which case it is not a script bug
          // at all — the label's child came back from the journal and has no
          // conversation here to continue. Saying "no agent has completed"
          // would send the reader hunting for a typo that is not there.
          respond(
            callId,
            false,
            undefined,
            replayedCount > 0 ?
              `agent() opts.resume: "${payload.resume}" was replayed from the resume journal, not run, so there is ` +
                "no conversation in this run to continue. Re-run without resumeFromRunId."
            : `agent() opts.resume: no agent has completed under the label "${payload.resume}" in this run. ${
                known.length === 0
                  ? "No agent has completed yet."
                  : `Known labels: ${known.map(label => `"${label}"`).join(", ")}.`
              }`,
            true,
          );
          return;
        }
      }

      // Compiled before anything is scheduled. A schema the runtime cannot use
      // is a script bug, so it is fatal like a typo'd resume label — folding it
      // into a null would surface as an agent that mysteriously returned
      // nothing, and it costs no model call to say so here.
      let compiledSchema: CompiledSchema | undefined;
      if (payload.schema !== undefined) {
        const compilation = compileJsonSchema(payload.schema);
        if (!compilation.ok) {
          respond(callId, false, undefined, compilation.message, true);
          return;
        }
        compiledSchema = compilation.compiled;
      }

      if (agentCount >= agentCap) {
        // Fatal, so parallel()/pipeline() rethrow instead of folding it into a
        // null. A cap that silently drops work is worse than no cap.
        respond(callId, false, undefined, `Workflow exceeded its cap of ${agentCap} agents.`, true);
        return;
      }
      const index = agentCount++;
      // A resumed call is the same child again: it keeps the agent id, so an
      // abort still reaches it, and it keeps its spawn contract, so the row
      // reads the same as the row it continues.
      const agentId = resumed?.agentId ?? `wf-agent-${index}`;
      const label = payload.label ?? resumed?.label ?? derivedLabel(payload.prompt);
      const agentType = resumed?.agentType ?? payload.agentType ?? "general-purpose";
      const model = resumed !== undefined ? resumed.model : payload.model;
      const isolation = resumed !== undefined ? resumed.isolation : payload.isolation;
      openLaunches.set(callId, label);

      const base: WorkflowAgentEntry = {
        type: "workflow_agent",
        index,
        label,
        state: "start",
        agentId,
        agentType,
        promptPreview: preview(payload.prompt),
        ...(model !== undefined ? { model } : {}),
        ...(isolation !== undefined ? { isolation } : {}),
        ...(payload.phaseIndex !== undefined ? { phaseIndex: payload.phaseIndex } : {}),
        ...(payload.phaseTitle !== undefined ? { phaseTitle: payload.phaseTitle } : {}),
      };

      const queuedAt = Date.now();
      emit([{ ...base, queuedAt }]);

      // Replay before the semaphore, not after: a cached answer is not model
      // running, so it must not hold a concurrency slot that a live agent
      // could use. The row still appears in the tree — the run reads as the
      // same shape it had the first time, just faster.
      // The payload's `schema` is the raw object; the key wants it serialized,
      // so the spread is narrowed rather than passed through.
      const keyInput: JournalKeyInput = {
        ...payload,
        schema: payload.schema !== undefined ? JSON.stringify(payload.schema) : undefined,
      };
      let replayed = replayAt(index, journalKey(keyInput));
      // A replayed answer still has to satisfy the schema. The key covers a
      // schema that *changed*, but not a journal that was hand-edited, and not
      // the empty text a torn entry leaves behind — either would hand the
      // script a null from an entry the journal claims succeeded.
      if (replayed !== undefined && compiledSchema !== undefined) {
        const recheck = applySchema({ ok: true, text: replayed.text ?? "" }, compiledSchema);
        if (!recheck.ok) {
          prefixIntact = false;
          replayed = undefined;
        }
      }
      if (replayed !== undefined) {
        replayedCount++;
        const replayedText = replayed.text ?? "";
        const at = Date.now();
        emit([
          {
            ...base,
            queuedAt,
            startedAt: at,
            lastProgressAt: at,
            durationMs: 0,
            state: "done",
            // The row reads as done, because it is — `cached` is what tells the
            // dialog to annotate it "from resume journal" rather than letting a
            // 0ms agent look like one that did the work impossibly fast.
            cached: true,
            resultPreview: preview(replayedText),
          },
        ]);
        openLaunches.delete(callId);
        // Re-recorded so this run's journal is complete on its own terms: a
        // resume of a resume must not have to walk back through a chain of
        // earlier files to find the prefix. The gate outcome travels with it —
        // the command is not re-run, but the verdict is still the audit trail
        // for the answer being handed back.
        recordJournal?.({
          index,
          key: replayed.key,
          ok: true,
          text: replayedText,
          ...(replayed.gate !== undefined ? { gate: replayed.gate } : {}),
        });
        respond(callId, true, replayedText);
        return;
      }

      const key = journalKey(keyInput);
      const resumeMark = payload.resume !== undefined ? ({ resumed: true } as const) : {};

      /** A skip the user asked for, before the child ever started. */
      const settleSkipped = (extra: Partial<WorkflowAgentEntry>) => {
        recordJournal?.({ index, key, ok: false, ...resumeMark });
        emit([{ ...base, queuedAt, ...extra, state: "error", skipped: true, error: "Skipped by user." }]);
        // `null`, exactly as a terminal failure gives — a skipped agent is one
        // the script's `.filter(Boolean)` was already written to survive.
        respond(callId, true, null);
      };

      // Registered for exactly as long as the call is unanswered, which is the
      // window in which skip and retry mean anything.
      const live: LiveAgent = { agentId, started: false };
      liveAgents.set(index, live);
      // Read through a call, not off the field: `intent` is set from outside
      // this function while it is suspended at an await, so control-flow
      // narrowing across the awaits would be reasoning about a value that has
      // since changed.
      const intent = (): LiveAgent["intent"] => live.intent;
      let attempt = 1;
      try {
        for (;;) {
          // Held before the slot, not after: a paused run must not sit on
          // concurrency it is not using while its running agents drain.
          await pauseGate(live);
          if (intent() === "skip") return settleSkipped({});

          // A resumed agent waits its turn like any other: it is the same amount of
          // model running at once.
          await semaphore.acquire();
          if (aborted || settled) {
            semaphore.release();
            respond(callId, false, undefined, "Workflow aborted.", true);
            return;
          }
          // Paused while parked behind the limit: this agent was waiting for a
          // permit when the pause landed, so it never passed the gate above.
          // Hand the permit back and go wait at the gate like everything else,
          // or a pause would leak exactly as many agents as were queued.
          if (isPaused() && !aborted && !settled) {
            semaphore.release();
            continue;
          }
          // Skipped while parked behind the limit: the permit arrived, and the
          // only thing left to do with it is give it back.
          if (intent() === "skip") {
            semaphore.release();
            return settleSkipped({});
          }

          // Carried on every emit from here on, so a retried row keeps saying
          // why it is on its second attempt instead of losing it to the next
          // progress update.
          const attemptMark =
            attempt > 1 ? { attempt, lastAttemptReason: "user-retry" as const } : {};

          const startedAt = Date.now();
          emit([{ ...base, queuedAt, startedAt, ...attemptMark }]);

          // Mutates `base` rather than emitting a standalone patch: every later
          // emit spreads it, so the settle path carries the effective values
          // without knowing they were ever corrected. Re-emitting under the
          // same `index` is what the append-only, last-write-wins progress log
          // is for — the row updates in place while the agent is still running.
          const onResolved = (info: {
            recordId?: string;
            modelName?: string;
            modelId?: string;
            thinking?: string;
            requestedThinking?: string;
            requestedModel?: string;
          }) => {
            if (info.recordId !== undefined) base.recordId = info.recordId;
            if (info.modelName !== undefined) base.model = info.modelName;
            if (info.modelId !== undefined) base.modelId = info.modelId;
            if (info.thinking !== undefined) base.thinking = info.thinking;
            if (info.requestedThinking !== undefined) base.requestedThinking = info.requestedThinking;
            if (info.requestedModel !== undefined) base.requestedModel = info.requestedModel;
            // `base.state` is still "start", so emitting after the row reached a
            // terminal state would revert it to running under last-write-wins.
            // Not reachable from this repo's host, which reports during startup
            // — but this is the host boundary, and every other promise it makes
            // is checked rather than trusted.
            if (!inflight.has(agentId)) return;
            emit([{ ...base, queuedAt, startedAt, ...attemptMark, lastProgressAt: Date.now() }]);
          };
          live.started = true;
          inflight.add(agentId);

          let result: WorkflowSpawnResult;
          /** This attempt's gate verdict, for the journal entry it settles into. */
          let gateOutcome: WorkflowJournalGate | undefined;
          try {
            result =
              resumed !== undefined && resumeAgent !== undefined
                ? await resumeAgent(resumed.agentId, payload.prompt, onResolved)
                : await host.spawnAgent({
                    agentId,
                    index,
                    prompt: payload.prompt,
                    label,
                    agentType,
                    ...(model !== undefined ? { model } : {}),
                    ...(payload.effort !== undefined ? { effort: payload.effort } : {}),
                    ...(compiledSchema !== undefined ? { schema: compiledSchema } : {}),
                    ...(isolation !== undefined ? { isolation } : {}),
                    ...(payload.phaseIndex !== undefined ? { phaseIndex: payload.phaseIndex } : {}),
                    ...(payload.phaseTitle !== undefined ? { phaseTitle: payload.phaseTitle } : {}),
                    // Offered, not delegated: a host that can run it inside the
                    // child's worktree does, and hands back `result.gate`.
                    ...(payload.gate !== undefined ? { gate: payload.gate } : {}),
                    onResolved,
                  });
            if (result.ok) {
              // Recorded before the gate runs: the child itself finished, so it is
              // resumable even when its gate rejects the work — "here is what the
              // gate said, fix it" is the loop this exists for.
              completedByLabel.set(label, {
                agentId,
                label,
                agentType,
                ...(model !== undefined ? { model } : {}),
                ...(isolation !== undefined ? { isolation } : {}),
              });
              // Re-checked here, not just in the child's tool: this is the one
              // place that decides the script's value matches the schema it
              // asked for, so a host that ignored `schema` fails loudly instead
              // of handing the script prose. Before the gate, because a gate
              // verifies work and there is no work to verify if the shape is
              // wrong — and the reader should see the schema error, not a gate
              // error standing in front of it.
              if (compiledSchema !== undefined && result.ok) {
                result = applySchema(result, compiledSchema);
              }
              if (result.ok && payload.gate !== undefined && runGate !== undefined) {
                const applied = await applyGate(result, payload.gate, agentId, runGate);
                result = applied.result;
                gateOutcome = applied.gate;
              }
            }
          } catch (error) {
            result = { ok: false, error: error instanceof Error ? error.message : String(error) };
          } finally {
            inflight.delete(agentId);
            live.started = false;
            semaphore.release();
          }

          if (settled) return;

          // The stop that produced this result was ours, so run the same call
          // again rather than reporting it. The script is still awaiting this
          // `agent()`, which is the only reason a retry can mean anything.
          if (intent() === "retry" && !aborted) {
            live.intent = undefined;
            attempt++;
            emit([{ ...base, queuedAt, attempt, lastAttemptReason: "user-retry" }]);
            continue;
          }

          // Counted before the response is sent, so the very call that spent
          // them already sees them in `budget.spent()`. Failed and skipped
          // agents count too — they burned the tokens either way.
          spentOutputTokens += result.outputTokens ?? 0;

          const finishedAt = Date.now();
          const common = {
            ...base,
            queuedAt,
            startedAt,
            ...attemptMark,
            lastProgressAt: finishedAt,
            durationMs: finishedAt - startedAt,
            ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
            ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
          };

          if (result.ok) {
            const text = result.text ?? "";
            emit([{ ...common, state: "done", resultPreview: preview(text) }]);
            recordJournal?.({
              index,
              key,
              ok: true,
              text,
              ...resumeMark,
              ...(gateOutcome !== undefined ? { gate: gateOutcome } : {}),
            });
            respond(callId, true, text);
            return;
          }
          // Recorded as a failure rather than left out: a gap would be read as an
          // unchanged prefix on the next resume, silently skipping the retry this
          // whole mechanism exists to make cheap. A failed gate is recorded with
          // its output and the directory it ran in, so an entry that reads `ok:
          // false` can be told from a child that simply failed.
          recordJournal?.({
            index,
            key,
            ok: false,
            ...resumeMark,
            ...(gateOutcome !== undefined ? { gate: gateOutcome } : {}),
          });
          // A dead agent is a null in the script, not a thrown error: Claude Code
          // scripts .filter(Boolean) rather than try/catch around every call.
          emit([
            {
              ...common,
              state: "error",
              // A user skip reaches here as a stopped child, which the host
              // already reports as skipped — the flag is taken from the result
              // rather than from the intent so an abort mid-skip still reads
              // as whatever actually happened to the child.
              error: result.error ?? "Agent failed.",
              ...(result.skipped ? { skipped: true } : {}),
            },
          ]);
          respond(callId, true, null);
          return;
        }
      } finally {
        liveAgents.delete(index);
      }
    }

    /**
     * Resolve one `workflow(ref)` and hand the child's source back compiled.
     *
     * Resolution failures are non-fatal — Claude Code documents `workflow()` as
     * throwing on an unknown name so a script can catch it and carry on. A host
     * with no `loadWorkflow` at all is fatal, matching how a missing `runGate`
     * or `resumeAgent` is treated: a capability the script asked for and this
     * host cannot provide is a wiring error, not a runtime condition.
     */
    async function handleLoadWorkflow(callId: number, ref: WorkflowScriptRef): Promise<void> {
      const loadWorkflow = host.loadWorkflow?.bind(host);
      if (loadWorkflow === undefined) {
        respond(callId, false, undefined, "This workflow host cannot run nested workflows.", true);
        return;
      }
      let source: WorkflowScriptSource;
      try {
        source = await loadWorkflow(ref);
      } catch (error) {
        respond(callId, false, undefined, error instanceof Error ? error.message : String(error));
        return;
      }
      if (!source.ok) {
        respond(callId, false, undefined, source.message);
        return;
      }
      try {
        const child = validateScript(source.script);
        respond(callId, true, {
          name: child.meta.name,
          metaJson: JSON.stringify(child.meta),
          body: child.body,
        });
      } catch (error) {
        respond(callId, false, undefined, error instanceof Error ? error.message : String(error));
      }
    }

    worker.on("message", (message: WorkerMessage) => {
      if (settled) return;
      switch (message.type) {
        case "progress":
          emit(message.entries);
          break;
        case "call":
          if (message.method === "workflow") {
            void handleLoadWorkflow(message.callId, message.payload as WorkflowScriptRef);
            break;
          }
          if (message.method !== "agent") {
            respond(message.callId, false, undefined, `Unknown workflow host method "${message.method}".`, true);
            break;
          }
          // Then, not in handleAgent's `finally`: the permit is released before
          // the last settled call reaches the journal, and draining there would
          // finish the run before its journal prefix was written.
          void handleAgent(message.callId, message.payload as AgentCallPayload).then(maybeFinishDrain, error => {
            // A rejected call leaves nothing to start, so a park stop still has
            // to see it settle. Outside a park the rejection propagates exactly
            // as this fire-and-forget dispatch always let it.
            maybeFinishDrain();
            if (!draining) throw error;
          });
          break;
        case "complete": {
          // The script is done, so every launch it made should have been
          // answered by now — a response is sent before the worker can post
          // this, so anything still open was never awaited. finish() aborts
          // those children on the way out.
          const unawaited = [...openLaunches.values()];
          if (unawaited.length > 0) {
            finish({ status: "failed", error: unawaitedLaunchMessage(unawaited) });
            break;
          }
          finish({
            status: "completed",
            ...(message.resultJson === undefined ? {} : { value: JSON.parse(message.resultJson) }),
          });
          break;
        }
        case "error":
          finish({ status: "failed", error: message.message });
          break;
      }
    });

    worker.on("error", error => {
      finish({ status: "failed", error: error instanceof Error ? error.message : String(error) });
    });

    worker.on("exit", () => {
      // Only reachable when the worker dies without reporting — a terminate()
      // we did not initiate, or a hard crash.
      finish({ status: "failed", error: "Workflow worker exited before completing." });
    });
  });
}
