# Child-to-parent questions: `ask_parent` / `answer_subagent`

Status: **design proposal** — not implemented. Evaluates and replaces the
mechanism proposed upstream in tintinweb/pi-subagents#410, which we reviewed and
declined to port as-is (see "Relation to upstream #410").

## Problem

A nested agent that hits a genuine ambiguity today has two options: guess and
continue silently, or end its run and hope the reader of the result notices.
Neither is good. Guessing wastes the whole run when the assumption is wrong;
stopping wastes the work already done when it was right.

Upstream #410 adds a post-hoc prose protocol: the child stamps a question on its
own record, finishes, and the question rides the result text as a
`[PARENT QUESTION]` footer; the parent resumes the child with the answer. We
found four defects in that design: the resume instruction is injected precisely
where the parent *cannot* resume (no `Agent` tool at the depth cap, without
`allowedSubagents`, or isolated); the question is dropped on error-path settles
and overwritten by a second ask; nothing enforces the "stop your turn"
instruction; and the footer is unescaped prose indistinguishable from the
child's own output. This document is the replacement.

## Principles

1. **Nothing blocks by default.** A child states its assumption and continues.
   Blocking is opt-in per call, because a blocked child holds attention and
   (without slot handoff) a concurrency slot.
2. **The answerer is computed, not assumed.** "Parent" resolves to the nearest
   party that can actually take a turn *now* — an unblocked ancestor, the
   workflow script, or the user. A question addressed to a party that cannot
   answer is a defect, not a corner case (this is #410's bug #1).
3. **Structured, never prose.** Questions live in typed record fields and reach
   the answerer as a rendered card or a tool result with a fixed header — never
   as a marker inside child-authored text.
4. **Every message has a defined fate.** Abort, error, park, `/new`, GC: each
   terminal event maps to an explicit question state. No silent drops.
5. **Ride existing machinery.** Steers, the completion outbox, pause gates and
   slot handoff, and the workflow `callHost` promise pattern already exist and
   are proven. This design adds no transport.

## The one mechanism, three delivery modes

A question is a record on the *asking child*. Delivery differs by who owns the
child and whether the child waits:

| Mode | Child | Answerer | When |
| --- | --- | --- | --- |
| **B — mailbox** (default) | continues on its stated assumption | free ancestor agent, via nudge + `answer_subagent` | child is detached, or owner is free |
| **A — result-time** (B's fallback) | has finished; question rides the result footer | the reader of the result, via `resume` | child is foreground (`blocking`), so its caller cannot take a turn until the child settles |
| **C — suspended** (opt-in `{ block: true }`) | parks at the run boundary, slot released | nearest *free* party: unblocked ancestor, the user (run page / notification), or the workflow script | child declares it cannot proceed at all |
| **D — workflow** (automatic for workflow children) | per its mode | the workflow script, via an awaited `ask()` primitive | spawner is a workflow (`workflowId` set, no `parentAgentId`) |

Mode selection: `block: true` forces C (D answers first if a workflow script is
wired). Otherwise B; A happens naturally when the child settles before an
answer arrives.

### Why foreground children cannot do true B

A foreground child is spawned through `spawnAndWait`; its parent's `Agent` tool
call is unresolved until the child settles, so a steer into the parent queues
for a turn that cannot start — answering mid-run would deadlock. This is
exactly why upstream #410 collapsed into post-hoc prose. The model-facing text
must be honest about it: a mailbox ask from a `blocking` child is delivered at
result time (mode A), and the tool result says so. Detached children
(`run_in_background: true`) get real mid-run B. `AgentRecord.blocking`
already encodes the distinction.

## Data model

`src/types.ts`:

```ts
export type QuestionState = "open" | "delivered" | "answered" | "superseded" | "expired" | "dropped";

export interface AgentQuestion {
  /** `q-1`, `q-2`, … unique within the asking record. */
  id: string;
  question: string;
  context?: string;
  /** What the child proceeds with in mailbox mode; required for non-blocking asks. */
  assumption?: string;
  mode: "mailbox" | "block";
  state: QuestionState;
  askedAt: number;
  answer?: string;
  /** Record id of the answerer, `"workflow"`, or `"user"`. */
  answeredBy?: string;
}

// AgentRecord additions:
/** Open and recently-answered questions this child has asked its owner. */
questions?: AgentQuestion[];
```

A list, not #410's single slot: a second ask supersedes the first *explicitly*
(state `superseded` on the old question, noted in the replacement's card)
instead of silently overwriting. Questions are never folded into `result` at
rest — same reason `structuredJson` is separate from `result`: appended prose
corrupts anything that wants to parse the payload. Formatting happens at
render/delivery time.

## Tools

### `ask_parent` (child-side, nested-only)

Added to `NESTED_TOOL_NAMES` in `src/nested-tools.ts`, built in
`createNestedSubagentTools`, so it inherits the existing injection path: nested
only, never isolated (the `!isolated` gate in `runner-session.ts` already
strips it), and filtered by the per-agent `disallowedTools` set the same way
the other nested tools are.

```ts
parameters: Type.Object({
  question: Type.String({ description: "The specific decision or fact you need." }),
  context: Type.Optional(Type.String({ description: "What you tried; why you cannot resolve it yourself." })),
  assumption: Type.Optional(Type.String({ description: "What you will do if no answer arrives. Required unless block: true." })),
  block: Type.Optional(Type.Boolean({ description: "Suspend instead of proceeding on an assumption. Use only when proceeding wrong is worse than not proceeding." })),
})
```

Execute (child-side): resolve the answerer (below), append the question,
then per mode:

- **mailbox**: return
  `"Question delivered to <owner description>. Continue with your stated assumption; the answer will reach you mid-run as a steering message."`
  (or, for a `blocking` child: `"…you will finish first; the question rides your result. Finish cleanly."`)
- **block**: return
  `"Question delivered. You are suspended until an answer or a timeout; do not attempt further work."`
  — the gate closes after this tool result lands (see mode C).

### `answer_subagent` (owner-side, two variants)

- **Top-level** (`src/tools/inspect-tools.ts`, beside `createSteerTool`):
  answers the main session's own children (`isTopLevelAgent` — `parentAgentId`
  undefined). Workflow-owned children are answered via the run page, not this
  tool.
- **Nested** (in `createNestedSubagentTools`): answers children passing
  `ownsRecord` — this is what fixes #410's impossible-instruction defect: the
  tool exists for a nested parent *only when that parent owns live children*.

```ts
parameters: Type.Object({
  agent_id: Type.String(),
  question_id: Type.Optional(Type.String({ description: "Defaults to the child's oldest open question." })),
  answer: Type.String(),
})
```

Execute: validate ownership + open question, set `state = "answered"`, then
deliver (mode-dependent, below). Errors are tool errors with the question id in
the text, so a stale `question_id` is diagnosable.

## Addressing: `resolveAnswerer(record)`

Walks the ownership chain and picks the first party that can take a turn:

1. `manager.getRecord(record.parentAgentId)` — if that record exists, is live,
   and `!record.blocking`, it answers (nudge + nested/top-level
   `answer_subagent`).
2. Else the next ancestor (`parentAgentId` chain), same test. Delivering to a
   grandparent means the *child's* question card names the ancestor; the
   answer still steers into the asking child directly — relay is routing, not
   prose rebroadcast (fixes #410's defect: relay becomes machinery).
3. If the child has `workflowId` — the workflow script answers (mode D), or the
   user via the run page.
4. Else the root session (depth-1 children): the completion-outbox nudge path
   (`pi.sendMessage`, `deliverAs: "steer", triggerTurn: true`) — depth-1
   parents are main-session turns, which the outbox already wakes correctly,
   including while parked (`holdWhileParked`).
5. Else (chain dead, nothing free, block mode): the user, via the run page and
   the notification card.

For mode C the walk *skips* blocked ancestors by construction (a suspended
child's foreground caller is blocked) and lands on 2–5; for mailbox mode an
all-blocked chain degrades to A (result-time) instead of suspending anyone.

## Mode C: suspension mechanics

Rides `PauseGate` without touching `pause()`/`unpause()` (whose status and
queue semantics are user-park specific):

```ts
// manager.suspendForQuestion(id, question): boolean
(record as GatedRecord).pauseGate = createPauseGate();
installPauseGate(record as GatedRecord, record.session);
// Status stays "running" — steers into a gated-but-running child land on
// agent.steeringQueue and drain right after finishTurn returns, which is the
// exact injection point on reopen. ("paused" would make the child unsteerable;
// the steer() status guard rejects it.)
const freed = record.slotHeld;
this.pool.releaseSlot(record);   // slot handoff: the pool does not starve
if (freed) this.drainQueue();

// manager.resumeForAnswer(id, answer): boolean  — mirrors resumeRecord's gate path
const pending = record.questions?.find(q => q.state === "delivered" && q.mode === "block");
void record.session?.steer(formatAnswer(pending, answer));  // queued before open
const p = record.chargedPool;
if (p !== undefined && !this.pool.poolHasRoom(p)) { /* queue; acquireSlot on start */ }
this.pool.acquireSlot(record);
gateOf(record)?.open();
```

Foreground children may suspend this way (unlike `pause()`): their caller is
blocked either way, and the released slot is precisely the point. Worktree
runs too — `pause()`'s worktree refusal exists for park/resume replay reasons
that do not apply; suspension never replays anything, the session is intact.

**Timeout**: `askBlockTimeoutMs` (default 600_000 — the GC window). On expiry:
`state = "expired"`, steer `"No answer within <n>m; proceeding on your stated
assumption (or failing if you cannot)."` before `gate.open()` + slot re-acquire.

## Mode D: workflow integration

`WorkflowHost` gains `answerQuestion(recordId, answer): boolean` and question
forwarding on its spawn records. Script surface, in `worker-source.ts` where
`sandbox` and `makeScope` bind globals:

```js
const answer = await ask(agentRef, question, { timeoutMs?: number })  // script-side
```

Backed by the existing `callHost("ask", …)` pendingCalls pattern — the call is
already an externally-resolved promise, so `await ask(...)` inside one
`parallel`/`pipeline` thunk parks only that branch; siblings proceed. The host
resolves the promise when the spawned record's question is answered by the
user (run page), an upstream agent, or a script-level default handler. The
asking child runs in mode C (suspended) by default — its slot is released, so
the run's other agents are not starved. `skip(index)` semantics extend
naturally: skipping a child with an open question resolves its `ask()` with
`null`, exactly as skip already resolves `agent()` with `null`.

## Message shapes

Question nudge (custom message to the answerer's session; UI renders it as a
card from `details`, models read the text):

```text
[SUBAGENT QUESTION] <type> "<description>" (agent id: <id>, question <qid>)
Q: <question>
Context: <context>
Child will proceed with: <assumption>          // mailbox only
Reply with answer_subagent(agent_id: "<id>", question_id: "<qid>", answer: "...").
```

Answer steer (into the asking child):

```text
[ANSWER to your ask_parent <qid>] <answer>
Continue with this answer; do not re-ask the same question.
```

Result-time footer (mode A only, formatted at `formatRecord` time from the
questions field — never stored into `result`):

```text
[QUESTION for you, question <qid>] <question>
This agent finished without an answer. Resume it with the answer if it matters;
otherwise it proceeded with: <assumption>.
```

The resume instruction appears **only** when the reader actually has a resume
path, which mode A's contexts (inline nested result, `get_subagent_result`)
always do — the defect in #410 came from emitting it unconditionally.

## Fate table

| Event | Open mailbox question | Open block question |
| --- | --- | --- |
| Child settles (no answer) | `state` stays `delivered`; footer rides the result; answer via `resume` marks `answered` pre-delivery | cannot happen — timeout first |
| Child error / abort (user or caller) | `dropped`; error text notes `N unanswered question(s)` | gate released via `stopGatedRun`'s existing `releaseGate`; `dropped` |
| Owner record removed (GC) | `dropped`; child continues on assumption (GC unchanged by this design — results already outlive consumption) | answerer walk re-runs once at suspend time only; no re-addressing later |
| `/new` / session switch | `clearCompleted()` removes records; questions die with them — consistent with every other record datum | same |
| Main-session `/pause` park | nudge held via existing `holdWhileParked`; flushed on continue | child suspension is orthogonal; the park's own gate sequencing (landPark) treats a question-gated child like any gated running child |
| User pauses the asking child | question stays `delivered`; answer steers when it resumes | impossible: gate already closed; answer reopens |
| Second `ask_parent` | old → `superseded`, replacement delivered; card says which question it supersedes | same; block mode permits one open block question — a second is refused as a tool error |
| `answer_subagent` races the timeout | first writer wins; loser gets a tool error naming the state | same |

## UI surfaces

- Notification/`get_subagent_result` renderer: question card variant
  (`NotificationDetails` gains `questions?: { id, question, assumption }[]`).
- Run page (W): pending-question badge on the agent row (`displayState`), an
  answer action beside skip/retry in `agentActions`; v1 ships badge + "answer
  on Enter" prompt; the fleet bar gets the badge only.
- Widget subtext for a block-suspended child: `waiting for answer (q-2)` —
  the record is `running` with a pending block question, which the activity
  tracker can prefer over tool narration.

## Scoping and security

- `ask_parent`/`answer_subagent` inject into EVERY non-isolated subagent, at
  any depth, with or without an `allowedSubagents` allowlist — asking needs an
  owner, not delegation headroom, and a leaf agent at the depth cap is exactly
  the agent most likely to need its parent. The depth cap and allowlist gate
  only the delegation tools (`Agent`, `get_subagent_result`,
  `steer_subagent`); isolated agents still receive none of these (their caller
  chose air-gapping).
- `disallowedTools: ["ask_parent"]` / `["answer_subagent"]` work through the
  existing per-agent deny set — no new exemption.
- A child can only address its own owner chain; there is no broadcast, no
  child-to-child channel, and `answer_subagent` validates ownership
  (`ownsRecord` / `isTopLevelAgent`) before touching state.
- Answers are steered text with a fixed header; they can carry no tool
  authority the child did not already have.

## Settings

- `askParent` (default `true`): master switch; `false` removes both tools and
  mid-run question delivery. Documented default change requires a CHANGELOG
  `**BREAKING**` note only if we later flip it.
- `askBlockTimeoutMs` (default `600000`).

## Phasing

| Phase | Scope | Files | Notes |
| --- | --- | --- | --- |
| 1 — B + A | question model, `ask_parent` (mailbox), `answer_subagent` (both variants), `resolveAnswerer`, nudge card, result footer, fate handling | `types.ts`, `nested-tools.ts`, `runner-session.ts`, `tools/inspect-tools.ts`, `manager/resume-handler.ts`, `completion-outbox.ts` (question items), `status-note.ts`, UI renderers, README, tests | the #410 replacement; independently shippable |
| 2 — C | `suspendForQuestion` / `resumeForAnswer`, `block: true`, timeout, widget subtext | `agent-manager.ts`, `manager/manager-types.ts` (helpers only), tests | needs Phase 1's answerer walk |
| 3 — D | `ask()` script global, host question routing, run-page answer prompt | `workflow/host.ts`, `workflow/worker-source.ts`, `workflow/runtime-types.ts`, `ui/workflow-view.ts`, `ui/agent-hub.ts`, tests | depends on C's suspension for the asking child |

## Testing

Per phase, in the fork's existing suites:

- Unit: state machine (ask/supersede/expire/answer/drop), `resolveAnswerer`
  walk (free parent, blocked parent, grandparent, workflow child, chain dead),
  slot accounting on suspend/resume (mirrors `pause-resume-repro` style),
  fate-table rows as table-driven cases.
- Wiring: ask → nudge delivery on idle vs busy owner (outbox patterns),
  answer → steer lands after `finishTurn` on a gated child, `disallowedTools`
  filtering, `ownsRecord` rejections.
- Mutation checks per the contributor guide: break the gate-close ordering
  (steer must precede `gate.open()`), break the timeout path, break ownership
  validation — each must turn a test red.

## Relation to upstream #410

Not a port. What we take from it: the tool names, the nested-tool registration
site, and the observation that `createNestedSubagentTools`' early-return
restructure is load-bearing for tool availability. What we replace: the
post-hoc prose protocol (structured fields + computed answerer), the
unconditional resume instruction (mode-conditional), the single-slot question
(list + explicit supersede), the silent error-path drop (fate table), and the
depth-guard deletion (not accepted; our factory keeps the existing gate). If
upstream later converges on something compatible, the question model and
message shapes here are deliberately close enough to rebase onto.
