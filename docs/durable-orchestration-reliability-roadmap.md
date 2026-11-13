# Durable orchestration reliability roadmap

## Status and intent

This proposal hardens the existing durable subagent and workflow implementation. It is not a claim that every capability below is absent. Existing foundations include Pi Durable-backed execution, replay classification for bridged tools, a completion outbox, file-backed pause manifests, workflow journals, and a configurable concurrency pool.

The goal is to make guarantees explicit, close cross-boundary failure windows, and test recovery end to end. Preserve these foundations; do not reimplement Harness execution or build a competing task engine.

## Current foundations to preserve

- `durable-runner.ts` delegates execution to `@earendil-works/pi-durable`.
- `durable-tool-bridge.ts` marks a small allowlist replay-safe and defaults other bridged tools to unsafe.
- `completion-outbox.ts` batches parent notifications and cancels pending notifications when results are consumed.
- `pause-store.ts` writes pause manifests using temp-file replacement and documents respawn limitations.
- Workflow tasks maintain progress and use journals for replay on resume.
- `ConcurrencyPool` provides foreground/background slot accounting and queue draining.

## P0 — Explicit tool side-effect and replay policies

### Problem

The durable bridge derives replay behavior from a fixed tool-name allowlist. This is conservative, but does not let tool authors explicitly declare idempotency, stable operation keys, or approval requirements. Name-based classification can become stale when a tool implementation changes.

### Required changes

- Introduce an explicit replay/side-effect policy at the bridge boundary, supplied by tool registration or a reviewed adapter policy.
- Keep unknown tools unsafe by default.
- Support safe replay, idempotent-with-operation-key, and never-automatically-replay.
- Require a stable operation ID for idempotent external mutations and document receiver-side deduplication.
- Preserve policy metadata for extension and MCP tools; emit diagnostics when a tool lacks an explicit policy.

### Acceptance criteria

- Tests cover safe reads, deterministic writes, non-idempotent mutations, and idempotent mutations with stable keys.
- A crash after an external mutation but before durable result commit does not silently repeat an unsafe operation.
- Newly bridged tools remain conservative by default.

## P0 — Recoverable, idempotent completion delivery

### Existing behavior

The completion outbox already batches notifications, and result consumption cancels a pending notification. Preserve that behavior.

### Required changes

- Verify whether outbox entries survive process exit. If not, persist pending completion envelopes containing agent/result reference, status, stable event ID, parent/session identity, and creation time.
- Model delivery as pending → delivered/acknowledged, with retry after restart.
- Deduplicate by stable event ID so resumed agents or repeated lifecycle events cannot create duplicate parent messages.
- Preserve suppression when a result is consumed before notification.
- Make stale-session delivery failures observable instead of silently treating them as delivered.

### Acceptance criteria

- Crash after settlement but before notification leaves a recoverable event.
- Crash after send but before acknowledgement does not create duplicate logical delivery.
- Tests cover parent idle/busy/abort/error, restart, result consumption, and duplicate callbacks.

## P0 — Orchestration ownership and recovery boundaries

### Problem

Execution durability and orchestration durability are different concerns. Harness should own agent execution state; the hub owns parent/child relationships, workflow dependencies, mission identity, and resume decisions. The pause manifest should remain a recovery index, not a second authoritative execution database.

### Required changes

- Document authoritative ownership for each persisted field: Harness/session, hub orchestration record, workflow journal, or pause manifest.
- Give long-lived orchestration runs stable IDs and parent/session correlation.
- Define recovery as reconciliation: inspect durable execution state, reconcile orchestration records, then resume only eligible work.
- Persist enough workflow dependency/result metadata to determine the next safe action after restart.
- Distinguish exact session recovery from best-effort respawn from the original prompt.

### Acceptance criteria

- Document recovery behavior for active, queued, paused, completed-unconsumed, failed, and missing-session agents.
- Running recovery twice creates no duplicate live agents or workflow runs.
- Missing/contradictory records produce visible diagnostics and a safe state.
- Fault-injection tests terminate between persistence boundaries in pause, resume, and workflow relaunch.

## P1 — Pause-manifest lifecycle and multi-process claims

### Existing behavior

The pause store documents atomic temp-file replacement and the lack of a PID lock. The main-turn record has a claim to guard continuation.

### Required changes

- Audit read/modify/write sequences for lost-update races between Pi processes sharing a session.
- Make the multi-window claim an atomic compare-and-set or equivalent lock with stale-claim recovery; avoid check-then-write races.
- Add schema validation and explicit manifest-version migration.
- Surface write failures; do not imply cross-restart recovery is guaranteed after a failed write.
- Make cleanup conservative: inability to prove a session is gone must not delete its manifest.
- Document filesystem assumptions, including rename semantics, permissions, and platform behavior.

### Acceptance criteria

- Concurrent continue attempts cannot both claim and resume the same parked main turn.
- Corrupt, old-version, and partial manifests are handled deterministically.
- Session-index lookup failure never deletes a potentially live manifest.
- Storage errors are observable and cannot falsely report a successful durable pause.

## P1 — Resource governance across execution sources

### Problem

The agent manager has a configurable concurrency pool, but direct agents, nested agents, workflow fan-out, resumed tasks, and scheduled work must be accounted for consistently.

### Required changes

- Define whether limits are per session, process, workspace, or global, and expose that scope.
- Route every start through a common admission controller, including workflow and scheduled starts.
- Coordinate foreground/background limits and priority classes.
- Add optional per-agent/workflow limits for turns, tokens, wall-clock duration, and tool calls where usage data exists.
- Ensure pause releases capacity and resume reacquires it before execution.
- Prevent nested fan-out from bypassing parent budgets or creating unbounded queues.

### Acceptance criteria

- Stress tests prove configured caps across direct, nested, workflow, resumed, and scheduled agents.
- Queue fairness covers interactive and recurring work.
- Cancellation and crash recovery reconcile each charged slot exactly once.
- Budget exhaustion yields a terminal, inspectable status and no orphaned tasks.

## P1 — Workspace and side-effect isolation

### Required changes

- Make workspace mode explicit: shared/read-only, shared/mutable, isolated worktree, or isolated environment.
- For parallel mutating agents, recommend or require isolated worktrees unless a workflow opts into shared mutation.
- Define worktree ownership and cleanup across crash, pause, resume, failed checkout, and parent cancellation.
- Prevent cleanup from removing worktrees referenced by live or recoverable agents.
- Include workspace identity in recovery metadata.

### Acceptance criteria

- Parallel agents modifying overlapping files in isolated mode cannot corrupt each other's worktree.
- Interrupted worktree creation/commit/cleanup is recoverable without deleting another agent's work.
- Shared mutable mode is explicit and visible in agent records/UI.

## P1 — Durable approvals for high-impact actions

### Required changes

- Add an approval state for tool calls/workflow steps crossing configured risk boundaries.
- Persist the request, proposed action, arguments with secret redaction, requester, and policy context.
- Resume the exact waiting action only after explicit approval; rejection/cancellation is terminal and auditable.
- Provide policies such as read-only, supervised mutations, and autonomous execution.
- Keep approval separate from replay safety: approval does not make an operation idempotent.

### Acceptance criteria

- Approval requests survive restart and remain pending.
- No protected action executes before approval.
- Rejection and timeout do not replay the protected tool.
- Approval and execution share stable audit IDs.

## P2 — Resumable event history and observability

### Required changes

- Define stable event IDs and per-agent sequence numbers for lifecycle, tool, workflow, and result events.
- Add replay-from-cursor or snapshot-plus-tail semantics at the hub layer if the underlying stream cannot resume.
- Deduplicate repeated events after reconnection.
- Expose recovery/replay decisions, retries, queue transitions, and delivery acknowledgements in structured diagnostics.
- Keep event retention bounded and configurable.

### Acceptance criteria

- A client reconnects from its last cursor and reconstructs state without missing or duplicating events.
- Nested agents/workflows correlate to their parent run.
- Diagnostics distinguish execution replay from UI event replay.

## P2 — Cross-session scheduling and lifecycle policy

### Required changes

- Define whether schedules belong to a Pi session, workspace, or user-level mission.
- Route scheduled work through the shared admission controller.
- Define behavior when the originating session is deleted, moved, or unavailable.
- Define retention, cancellation, and recovery for orphaned scheduled tasks.
- Preserve current semantics unless a deliberate migration is approved.

### Acceptance criteria

- Schedule ownership and recovery policy are visible and persisted.
- Session deletion cannot silently leave unowned recurring work.
- Scheduled starts respect resource limits and cancellation policy.

## Fault-injection test plan

1. Tool side effect succeeds; process dies before durable result commit.
2. Agent settles; process dies before completion notification.
3. Notification sends; process dies before acknowledgement.
4. Pause-manifest write fails after agents have been parked.
5. Two processes attempt to resume the same manifest concurrently.
6. Workflow journal advances; process dies before task status update.
7. Parent disappears while children are active or queued.
8. Worktree creation or cleanup is interrupted.
9. Scheduled and nested fan-out compete for a full concurrency pool.
10. Event consumer reconnects after missing multiple events.

For each case, assert resulting state, user-visible report, side-effect count, and absence of duplicate live work.

## Non-goals

- Replacing Pi Durable's Harness, task scheduler, or conversation persistence.
- Guaranteeing exactly-once effects for external systems without idempotency keys or transactional APIs.
- Rewriting the UI or introducing a new database before an audit shows existing storage cannot meet the guarantees.

## Suggested delivery order

1. Tool replay policy and side-effect tests.
2. Completion outbox durability and acknowledgement.
3. Recovery/ownership model and pause-store concurrency.
4. Unified admission control and budgets.
5. Workspace isolation hardening.
6. Approval workflow.
7. Resumable event history.
8. Cross-session scheduling policy.
