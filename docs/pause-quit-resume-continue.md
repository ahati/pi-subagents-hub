# PRD — Global `/pause` and `/continue`

Status: implemented. This document is the product requirements specification
for the global `/pause` and `/continue` commands: what they must do for the
user, and the design approach that delivers it. Implementation details,
source layout, and test internals are intentionally out of scope.

---

## 1. Problem

A pi session with active subagents loses work when it ends. Finishing a
workday mid-task meant either letting every agent run to completion (burning
time and tokens) or killing the session and losing in-flight work, pending
delegations, and finished-but-unread reports. There was no way to stop the
whole agentic execution cleanly, leave, come back, and pick everything up
where it stopped.

The previous `/pause` also refused to run while the main model was producing
output — precisely the moment users reach for it — and `/continue` after a
restart re-drove the parked turn without the extension's tools, failing on
the first subagent-related call.

## 2. Goals

- One command (`/pause`) stops the entire agentic execution — the main
  model's current turn and every active subagent — deterministically and
  without destroying anything.
- One command (`/continue`) resumes all of it, in any session state, with
  **no synthetic prompts of any kind**: the work continues exactly where it
  stopped.
- The full cycle — `/pause`, quit, `/resume`, `/continue` — works.
- All per-agent pause/resume surfaces (commands, menu, hotkeys, RPC) behave
  identically to the global pair.

## 3. Non-goals

- Pausing foreground agents a caller is blocked on, worktree-isolated
  runs, or agents owned by another agent or a workflow (existing refusals
  remain).
- Keeping a parked run alive across a crash (in-flight model streams are
  process-bound; the persisted transcript is the recovery surface).
- Delivering results of agents the user already consumed before pausing.

## 4. Functional requirements

### 4.1 `/pause`

- **FR-P1 (idle)** With the main agent idle, `/pause` parks every active
  top-level subagent and every completed-but-unconsumed agent (see 4.4), and
  writes the park manifest. Agents a caller is blocked on and
  worktree-isolated runs are refused with a visible reason; owned agents are
  outside the park's selection, which addresses top-level agents.
- **FR-P2 (streaming → armed)** With the main model producing output,
  `/pause` arms the park instead of acting. Nothing is parked yet; a second
  `/pause` cancels the arming.
- **FR-P3 (landing)** The armed park lands at the first boundary after
  arming: **before the next not-yet-started tool call**, or — if the current
  message's tools are already executing or the message makes none — **before
  the next model request**. Pending tool calls stay unanswered; no synthetic
  results are written for them.
- **FR-P4 (mid-tool rule)** A tool call already executing when `/pause`
  lands runs to completion and its output is persisted normally. It is
  never re-executed. Only calls that had not started are held.
- **FR-P5 (scope)** The park includes every active top-level subagent and
  the main turn. Refusals (foreground, worktree-isolated) are named in the
  landing summary and excluded from the manifest; everything else parks.
  Owned agents are not selected in the first place, so they are neither
  parked nor named (FR-P1).
- **FR-P6 (cancel)** `/pause` while armed disarms. A later boundary then
  lands nothing.
- **FR-P7 (Esc)** Pressing Esc while armed still lands the park (the user
  asked to stop everything; the interrupted turn is simply over). Pressing
  Esc while parked releases the suspension: the held call is closed with an
  aborted result, the main turn unwinds, and the subagents stay parked for
  `/continue`.
- **FR-P8 (quit)** Quitting while parked persists the parked state: the
  transcript (with unanswered calls where they are) and the manifest.
  Quitting while merely armed lands the park best-effort first, so nothing
  is lost by quitting quickly.
- **FR-P9 (visibility)** Each landing reports what was parked: the main
  turn, how many pending tool calls, which subagents parked, which were
  skipped and why, and how much held input is stored for `/continue`. The
  subagent count is split: agents with a session file are revived exactly,
  agents without one are re-run from scratch by `/continue`, and only a
  record with neither a session nor a prompt is reported as lost on quit.

### 4.2 `/continue`

- **FR-C1 (pure mechanics)** `/continue` reopens the park. Pending tool
  calls execute, their results are appended, and the next model request goes
  out as a bare continuation of the existing transcript. `/continue`
  **never** adds, replays, or synthesizes any message — no "continue"
  prompt, no held-input replay, no subagent continuation instruction. The
  only messages ever delivered are ones the user typed.
- **FR-C2 (subagents)** Parked subagent runs resume in place the same way.
  Subagents parked out of the queue re-enter with their original prompt
  (that prompt is their task, not a continuation). A subagent whose transcript
  ends with unanswered tool calls gets those calls executed, then continues
  bare. A subagent that left no session file at all (`persist_session: false`,
  or a queued spawn) is re-run fresh from its original prompt — a new
  conversation, never a synthetic continuation.
- **FR-C3 (completed work)** A parked agent whose transcript ends with its
  final answer is recognized as done: it is revived as a completed agent
  with that answer as its result, and the result is delivered to the user
  through the ordinary completion notification. No model call is made for it.
- **FR-C4 (across restart)** After quit and a fresh `/resume`, `/continue`
  restores the same state: subagent entries with a session file are revived
  from it, entries carrying only a respawn recipe are re-run from scratch,
  and the parked main turn's pending tool calls are executed and the turn
  continued from the reloaded transcript. A provider cache miss after
  long inactivity is acceptable.
- **FR-C5 (empty parks)** If nothing was parked, `/continue` says so. If
  only some entries can be restored (deleted session file, disabled agent
  type, a model that no longer resolves), those stay parked for a later
  attempt and the failure is reported. Re-run rows are counted separately
  and the report says the earlier transcript and tool state are gone.
- **FR-C6 (typing while parked)** Input typed while armed or parked behaves
  like input typed during any run: it is queued by pi and delivered when the
  run resumes. It does not survive quitting.

### 4.3 Parked-state visibility

- **FR-V1** The resumed session announces parked work on load: how many
  subagents and whether the main turn is parked, with the pending-call count.
- **FR-V2** A second pi window cannot run `/continue` for a park another
  live window is currently continuing; the attempt is refused with a visible
  reason and is safe to retry later.

### 4.4 RPC and surfaces

- **FR-S1** Every per-agent pause/resume surface — `/agents pause|resume`,
  the `/agents` menu, fleet and hub hotkeys, and the RPC channels — follows
  the same park/resume mechanism. The RPC `resume` prompt is honoured only
  for a user-typed redirect of a non-parked record; parked agents always
  resume bare.

## 5. Design approach

The design rests on four mechanisms. Their common principle: **pausing
suspends, it never aborts**, and **`/continue` never speaks** — it only
reopens what was suspended.

### 5.1 Boundary gates

The extension holds a *gate*: a suspended, unresolved handler promise at one
of pi's awaited boundaries — immediately before a pending tool call
executes, or at the end of a turn before the next request. While the gate is
closed, the loop is parked: nothing executes, nothing is sent, and the
transcript stands exactly at the boundary. `/continue` resolves the gate and
pi's own loop proceeds — tool, results, next request — as an ordinary
continuation. Suspending at the boundary (rather than aborting) is what
makes the bare continuation possible and lossless: the run was never
stopped.

Gates always race the run's abort signal. Esc must be able to release a
parked gate — otherwise the session could never go idle again — and the
release path closes the held call with an honest aborted result.

The park lands at the earliest boundary after arming, which implements
FR-P3/P4 exactly: pi reports each boundary only after the prior work is
persisted, so a tool that was running finishes and its output lands in the
session before the gate closes.

A park also hands the run's concurrency slot back: a parked run is not
running, and since paused records are exempt from the record GC nothing else
would ever reclaim the slot — a wall of parked agents would otherwise starve
the queue behind them. A resume re-takes the slot *before* opening the gate,
and queues the reopen when the pool is full, so `/continue` on a large park
resumes in pool-sized waves rather than all at once: the reply for a parked
agent may report it as `queued` (still `success: true`). Records charged to
neither pool — nested children, workflow agents — reopen immediately, since
they never held a slot.

### 5.2 Park manifest

The park state that must survive a process lives in a per-session manifest
next to the project: one JSON file holding the parked subagent rows (each with
its handle and alias, plus either its session file or a respawn recipe — the
original prompt and the invocation fields the live record held at pause time),
the main turn's parked flag with
its pending-call count, a liveness claim (pid + time), and timestamps. The
manifest is rewritten atomically on every state change and every rewrite
**preserves** fields it does not own — a rewrite can never erase a parked main
turn. Reads fall back to scanning the park directory, so the manifest is found
even when the session is resumed from a different working directory.

Cross-restart `/continue` also acquires a per-manifest
`<session>.json.continue-lock`. Exclusive file creation (`open(..., "wx")`)
is the atomic decision point, so this lock does not require hard-link support.
The owner record includes a random token, preventing one activation from
releasing another activation's lock even when they share a process ID. A
contender with a live owner is reported as busy; a malformed or partially
written lock fails closed and reports its path. A stale owner is reclaimed
only after its PID is confirmed absent. The lock is held for the whole shadow
continuation and released on success or failure. The manifest directory must
support exclusive file creation and deletion.

The pending tool calls themselves are never duplicated into the manifest:
the transcript already holds them, and the transcript is the source of
truth.

The manifest carries a format version; **version 3** is current. It adds an
optional `workflows` array, one row per parked workflow run — run id, journal
path, the exact script source, its `args`, the tool call that started it, and
the park time — because a run specified inline has no file on disk to replay
from. Reads stay tolerant of every earlier version: the version field is
informational, a missing or shorter `workflows` array reads as no parked runs,
and a v1/v2 manifest keeps working. An older build reading a v3 file sees the
subagent rows and the parked main turn it already understands, but drops the
workflow rows it does not know about on its next write; a newer build
rewrites the file as v3.

A manifest is only useful to the session that wrote it, so when a session
starts it sweeps the manifests in that directory whose owning session no
longer exists — a deleted session can never continue its park, and nothing
else would ever remove the file. The sweep needs a resolvable session
directory: without one an id it cannot find is not proof the session is
gone, and the file is left alone. Rows *inside* a live manifest whose agent
could not be revived are untouched — they stay parked for a later attempt.


### 5.3 Shadow continuation (cross-restart main turn)

After a restart, no run exists to un-gate, and pi offers no way to start a
turn without a message. `/continue` therefore continues the parked main turn
in a **shadow session**: a second, extension-owned session opened on the
same session file. In it, the extension executes the pending tool calls
through the real tool pipeline (validation, hooks and events intact), appends
their results, and issues the bare continuation request — the full
conversation, no new message. When the turn settles, `/continue` points pi's
own session-switch at the same file, so the live interface reloads and
displays the continued transcript. The manifest PID claim and atomic per-manifest lock guard the whole
operation; a refusal is always visible and retryable.

The shadow runs with a deliberately minimal tool surface: built-in tools
plus a small read-only subset of the extension's own tools (result lookup
and agent spawning, resolved against the live manager registry). Tools that
cannot work there resolve as honest errors the model can re-plan around.
Nothing is faked: a call that cannot run says so.

### 5.4 Fresh-activation revival

A session switch tears down the activation that dispatched `/continue`. The
revival of parked subagents therefore does not run through that
dispatching activation's closures: the park's shutdown handler recognizes an
own-switch teardown, skips destroying the manager, releases the registry
slot, and lets the replacement activation publish fresh closures — which the
revival then resolves and uses. Children launched during the continued turn
run in the surviving (resumed) activation.

### 5.5 Result capture and delivery

`/pause` additionally captures settled agents whose results were never
consumed, as manifest rows. `/continue` delivers each captured result
through the ordinary completion notification — from the live record in
process, or by reading the final assistant report from the agent's session
file after a restart — and marks it consumed. Already-consumed results are
never re-delivered. An agent parked exactly at a finished turn (final
answer persisted, nothing pending) is delivered rather than revived: its
report is the result. Each captured row carries the outcome its run settled
with (`completed`, `steered` or `error`, plus the failure text of an errored
run), and the delivery renders that outcome exactly as the live completion
notification would — an agent that errored before a restart is not reported
as a completion. Rows written before this field existed, and rows for parked
runs, are still treated as completions and rendered like one — the delivered
band reads `<status>Done</status>`, as a live clean completion does — but
nothing claims a status the run never settled with.

### 5.6 Held input and notifications

Input typed while armed or parked is handled by pi's native queueing and
reaches the model when the run resumes (the queues drain only after the
gates reopen). Completion notifications for agents finishing while the main
turn is parked are held and flushed by `/continue`, so a parked state cannot
be woken by its own notifications.

## 6. Acceptance scenarios

Each scenario is covered by an automated test and was reproduced against
real sessions and the real resume flow.

1. `/pause` while streaming, mid-tool-call → the batch suspends before
   execution; the manifest records the pending calls; nothing synthetic is
   written.
2. `/pause` on a final-text turn → subagents park; `/continue` reports
   there was nothing to continue on the main side.
3. Esc while parked → gate releases with an aborted result; subagents stay
   parked; the session can still be torn down cleanly.
4. `/continue` in-session → pending calls execute; the next request is
   bare; the manifest clears; no prompt-sending API is touched.
5. Quit while parked → transcript and manifest survive verbatim; after
   `/resume`, `/continue` executes the pending calls and the turn continues
   (shadow continuation + adoption), with the real model.
6. A parked child whose transcript ends with its final answer → `/continue`
   adopts it as completed with that answer as the result; no error, no model
   call.
7. Quit while the park is still armed → the shutdown lands it best-effort;
   after `/resume`, `/continue` still heals and revives everything.
8. Completed-but-unconsumed agents at `/pause` → captured; `/continue`
   delivers their reports as completion notifications and clears the park.
9. Every per-agent surface (commands, menu, hotkeys, RPC) parks and resumes
   bare; queued agents re-enter with their original prompt.
10. A second live window cannot claim a park that the first window is
    continuing.
11. An agent with `persist_session: false` parked, then quit → `/continue`
    re-runs it with its original prompt and reclaims its handle and alias;
    the notification says the earlier transcript and tool state are gone.

## 7. Known limitations

- If the process crashes while it owns the short-lived `.continue-lock.recovery` marker
  used to serialize stale-lock cleanup, and a stale main-turn lock remains beside
  it, `/continue` fails closed and reports the marker path. After confirming the
  recorded PID is no longer running, remove that `.recovery` file and retry; the
  main-turn lock itself is reclaimed automatically when its owner PID is gone.
- PID checks cannot distinguish the original owner from an unrelated process that
  later reuses the same PID. In that rare case the lock is reported as busy.
  Verify the process and session before manually removing the lock; there is
  deliberately no age-based lease because a long-running continuation must not
  be stolen.
- The continued main turn after a restart runs in a shadow session and is
  adopted via a session switch: the interface shows a reload, and input
  typed during the continuation lands as a sibling branch afterwards.
- Pending calls to tools that require session-scoped resources (for example
  MCP-backed tools) cannot execute in the shadow continuation; they resolve
  as honest errors and the model re-plans.
- The shadow-continued turn skips pi's automatic compaction and retry for
  that one turn; a provider error appears as an error turn in the adopted
  transcript.
- Input typed while parked is lost on quit (pi-native queueing behaviour).
- A respawned agent starts a new conversation: the earlier transcript, tool
  state, structured-output schema, group/join membership and usage history
  are not restored. Model, thinking, max turns and isolation are replayed
  only as far as the live record held them — a queued or mention-spawned
  agent has no invocation snapshot, so the agent config and pi defaults
  decide. The stored prompt is kept verbatim, which grows the manifest.
- An agent that settled while parked keeps `paused` status: after a restart
  `/continue` restores it from the manifest, from its session file when it has
  one (a transcript that ends on the final answer is delivered as the result),
  otherwise by re-running its respawn recipe — the task is run again, not lost.
- Prompt-cache misses after long pauses are expected and accepted.
