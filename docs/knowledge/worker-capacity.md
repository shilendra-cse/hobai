# Worker capacity

> Status: **Baseline measured, no fixes built** · Last updated: 2026-11-01 · Code: `apps/worker`, `packages/agent` · Related: [architecture.md](./architecture.md) §10 "Capacity", [agent.md](./agent.md)

The goal: **1,000 runs at once on one 2 vCPU / 8 GB VPS.** Everything heavy happens in the sandbox or at OpenAI; the worker only waits on them, so nothing it does should need much CPU or memory. This page lists what stops it today, found by reading the code and measured with the load harness (§4). Sandbox quota, OpenAI rate limits and spend caps are outside the worker and left out.

The costs in §2 are estimates from reading the code; §5 has what the baseline measured.

## 1. Where we are

- **Today's limit: ~250 runs cleanly, 500 with multi-second lag, 1,000 fails** (§5). The event loop (bottlenecks 2 and 5) and the Postgres pool (bottleneck 3) give out first; when they do, healthy runs lose their queue lock and are failed (bottleneck 6). Memory isn't the limit: ~1.8 MB per active run, a third of the estimate.
- **Node uses one core.** JavaScript runs on a single event loop; one process can't use the second vCPU.
- **The heap stops at ~2.2 GB.** V8 sets its limit from the machine's RAM (`v8.getHeapStatistics().heap_size_limit` is 2,240 MB on an 8 GB machine). The Dockerfile doesn't set `--max-old-space-size`, so the worker crashes with "JavaScript heap out of memory" while ~5 GB of RAM is unused.

## 2. Bottlenecks

Numbered in the order they were found; §5 has which ones the baseline hit.

| # | Bottleneck | Kind | Cause | Fix |
|---|---|---|---|---|
| 1 | ~~Step request bodies pile up~~ **Ruled out** | memory | The kept requests point at strings already in memory; they don't copy them | None needed |
| 2 | `text_delta` handled per token | CPU | The sink does full work for every text token | Batch deltas |
| 3 | One INSERT per stored event | Postgres pool | 20 connections, a round trip each | One multi-row INSERT for all runs |
| 4 | Old tool results kept in full | memory, linear | Compaction shrinks only what's sent | Store the compacted form |
| 5 | Compactor check every step | CPU | Stringify and rebuild the whole conversation each step | Use reported usage; keep the view |
| 6 | Late lock renewals fail healthy runs | queue | A frozen event loop misses the 2-min lock; the run is failed but keeps running | Fix 2, 3, 5; stop a run's work when its lock is lost |
| 7 | Runs that never end | hang | 17 runs waited on something that never answered | Find the missing timeout |

### 2.1 Bottleneck 1: step request bodies pile up (ruled out)

**What was assumed.** `streamText` keeps every step's result, including `request.body`, in `recordedSteps` until the call ends (`ai/dist/index.mjs`, `DefaultStepResult`; `@ai-sdk/openai` returns `request: { body: args }`). Counting each kept request at its size as sent (~10 KB added per step → ~50 MB after 100 steps), that looked quadratic.

**What actually happens.** The kept `body` is the request **object**, not the JSON text sent over the network; serializing happens at send time, on a temporary string that's thrown away. The object holds **references** to strings already in memory, not copies. Our tools all return strings, and the provider passes a `"text"` tool output through as the same string (`function_call_output`, `contentValue = output.value`), so every kept request points at the same tool results.

**Measured.** 150 fake steps with 10 KB tool results: counting by size predicts 113 MB; dropping all kept requests freed **1.4 MB**. With 50 KB results it still freed 1.4 MB: bigger results don't make the kept requests bigger.

**One part does get copied.** The provider rebuilds tool-call **arguments** on every step (`arguments: JSON.stringify(part.input)`), so each kept request has its own copy of every earlier call's arguments. Mostly tiny (`read_file("src/date.ts")`), but `write_file` and `edit_file` carry file contents: e.g. 10 writes of 10 KB, kept across ~100 later steps, ≈ 10 MB for that run. Small, and only for runs that write a lot; counted under §2.4. A tool returning an object instead of a string would also be copied every step (`"json"` outputs are `JSON.stringify`'d per request), so tools should keep returning strings.

### 2.2 Bottleneck 2: `text_delta` handled per token (CPU)

**What `text_delta` is.** One piece of the agent's text as it streams in, usually a token (`" file"`). It exists for one UI element: the live line of the agent's latest text under "Working" on the run page (`use-run-events.ts`, `run-activity.tsx`), cleared on every `tool_start`. It's live only: published, never stored, gone on reload. The CLI doesn't use it.

**How events reach the browser.** The agent loop emits events → the sink (`apps/worker/src/events/sink.ts`) → stored events are inserted into `run_events` with a `seq` → every event is published on Redis `run:<id>` → the API, subscribed to it, sends it to the browser over SSE.

**What the sink does for each `text_delta`:**

1. `toRunEvent` builds the event, with `new Date().toISOString()`.
2. A new promise joins the run's serial queue.
3. `redactGithubTokensIn`: `JSON.stringify`, regex, `JSON.parse`, to check a few characters.
4. `JSON.stringify` again for Redis.
5. One Redis PUBLISH, with a promise waiting for the reply.

**Why only this event.** Every event gets the same work, but `text_delta` happens once per token (~70 a second while the model writes); all other events together are ~1 a second per run (once per tool call, per step, or per run).

**The math.** Including the SDK's own parsing, ~50 µs per token. One core does ~20k tokens a second at 100%, ~10k with headroom for everything else on the loop. At ~70 tokens a second, that's ~140 runs writing at once; with 30–50% of runs writing at any moment, **~300–500 runs per process**. Past that, event-loop lag grows, BullMQ lock renewals fall behind (with `maxStalledCount: 0` a stalled lock ends a healthy run), and the sink's queue backs up.

**Fix.** The sink buffers a run's deltas and sends one `text_delta` every ~100 ms, before any other event (keeps order), and on `flush()`. The event shape doesn't change. Redact the joined string with `redactGithubTokens`, which also catches a token split across two deltas. ~10 sends a second per run instead of ~70.

**Measured.** Not separated from the other CPU costs yet (a CPU profile would). The event loop held up to 2.8 s at 500 runs and 7.6 s at 1,000, worst in the first minutes when every run streams at the same time (§5).

**Product call, left open.** The SDK still parses every streamed chunk, text and tool arguments alike, which we can only avoid by not streaming. Sending `text_delta` only while someone watches the run is a possible follow-up; most runs have no viewer.

### 2.3 Bottleneck 3: one INSERT per stored event (Postgres pool)

**What happens.** Every stored event (`tool_start`, `tool_end`, `stage_changed`, …) is its own INSERT. The pool (`packages/db/src/client.ts`) has `max: 20`, shared by every run in the process; each INSERT holds a connection for a ~5–10 ms round trip to Neon.

**The math.** 20 × (1 s / ~7 ms) ≈ 3,000 inserts a second at best; 1,000 runs × ~1 stored event a second ≈ 1,000, more in bursts, plus other queries on the same pool.

**When it's full, events are lost.** A query waiting over `connectionTimeoutMillis: 2_000` throws; the event is neither stored nor published; the run goes on and `flush()` logs "Some run events weren't saved or published". The run's timeline has a hole.

**Fix.** One event writer per process: sinks hand it their stored events in order, and every ~50–100 ms it writes one multi-row INSERT for all runs (the sink already numbers `seq`), then publishes each in order. Batching per run doesn't help: one run has ~1 event a second.

**Measured.** Up to 65 queries waiting for a connection at 500 runs and ~900 at 1,000, where 533 runs logged "Some run events weren't saved or published" (§5).

### 2.4 Bottleneck 4: old tool results kept in full (memory)

**What's kept.** `state.messages` (`run-segment.ts`) holds the conversation: the task, each tool call, each tool result. Tool results are most of it: test output, file contents, logs. Each tool caps what it returns to the model: `bash` at 28,000 characters (the full output stays in a log in the sandbox), `read_file` at 2,000 lines, `search` at 100 matches, `list_files` at 500 entries, failing checks at 6,000 characters each. So a single result is at most tens of KB; a command's raw output (up to 1 MB, `MAX_OUTPUT_BYTES`) is only in memory until the tool shortens it.

**What compaction does.** Before each model call, `Compactor.apply` (`compaction.ts`) checks the size; over 60% of the 272k-token window, it builds a compacted **copy** where old tool results become one line (`"[read src/date.ts, output removed]"`) and sends that. The copy is never written back: `state.messages` keeps every old result in full, though the model never gets them again.

**Why it matters.** This is the memory that actually grows: per run, with every step, linearly (plus the tool-call argument copies from §2.1): ~1–2 MB of text for a typical run, tens of MB with large logs or files. A large live heap also lengthens GC pauses, which stop the single thread.

**Measured.** Less than estimated: ~1.8 MB of heap per active run on the mixed profile, 1.9 GB at 1,000 runs (§5). It doesn't run out first, but near the limit GC took up to ~90% of a second, which feeds the event-loop stalls of §2.6.

**Fix.** Once a step is compacted, replace its tool results in `state.messages` too. The tool calls stay; only the results compaction already removed go. The model sees exactly what it sees today, and each run's memory stays at about the compaction size however long it runs.

### 2.5 Bottleneck 5: compactor check every step (CPU)

**What happens.** `prepareStep` calls `Compactor.apply` before every model call. Each time, it:

1. `compactBefore`: rebuilds the compacted copy from scratch (free before the first compaction, a full walk after).
2. `estimateTokens`: `JSON.stringify` of the whole view, only to count characters.
3. Compacts only when over the trigger, a few times per long run; then the `keep = 10…3` loop stringifies up to ~8 more times.

The cost is the check, not the compaction.

**The math.** With conversations up to ~650 KB (60% of the window), ~1–3 ms per full pass; ~100–300 steps a second at 1,000 runs.

**Fix.** Count tokens from the input tokens OpenAI reported for the last step, plus an estimate for what was added since; keep the compacted view between steps and append to it, rebuilding only when compaction moves forward. Behaviour doesn't change.

**Measured.** Once the short runs of the 1,000 level were done, ~200 long runs near the compaction size still held the event loop up to ~2 s at a time (§5).

### 2.6 Bottleneck 6: late lock renewals fail healthy runs (queue)

**What happens.** BullMQ keeps a run's job active only while the worker renews its lock; `lockDuration` is 2 minutes and `maxStalledCount: 0` (`consumer.ts`), so a job whose lock lapses is failed, not retried. When the event loop stalls for seconds and Redis commands queue up behind ~1,000 runs' work, some renewals arrive too late. The queue fails the job (`Work failed`); the reaper, every 5 minutes, sees the run `running` in Postgres but not active in the queue and ends it as `worker_lost` (`Failed a lost run`).

**The run doesn't stop.** Nothing aborts the handler, so the worker keeps running a run that's already been failed: CPU spent on dead runs, while the overload that caused it continues.

**Measured.** At 1,000 runs: 493 jobs failed this way and 490 runs were ended by the reaper, most of them together in minutes 13–15 (the reaper itself was slowed by the overload). Once they were gone the event loop recovered within a minute.

**Fix.** Mainly keep the event loop responsive (bottlenecks 2, 3, 5). Also stop a run's work when its lock is lost (see what BullMQ 6 exposes, e.g. a lock-renewal-failed event), so a failed run doesn't keep using CPU or a sandbox.

### 2.7 Bottleneck 7: runs that never end (hang)

**Measured.** At 1,000 runs, 17 runs stayed active for the last ~18 minutes of the level with the worker at ~2% CPU, until the level timed out: waiting on something that never answered. The fake OpenAI server closed a few connections while the worker was stalled (`Cannot connect to API: other side closed` in the log), so a model request without a time limit is the first suspect; not confirmed.

**Why it matters.** In production a run that never ends holds a concurrency slot and a sandbox until the 45-minute run limit, if that limit covers where it's stuck.

**Fix.** Find what they wait on (a run's last events, or a heap snapshot of a stuck worker), then add the missing timeout.

## 3. What's left after the fixes

The SDK's own work, which we can't remove while we stream and re-send the conversation:

| SDK work | At 1,000 runs |
|---|---|
| Per token: parse and validate each streamed chunk (~28k a second × ~15 µs) | ≈ 0.4 core |
| Per step: validate, convert and stringify the whole conversation (~100–300 steps a second × ~3–5 ms) | ≈ 0.3–1.5 cores |
| **Total** | **≈ 0.7–2 cores** |

With two processes (2 cores), 1,000 runs fit when conversations are small and sit at the limit when many long runs are near the compaction ceiling. **How much is re-sent each step decides it.** Two options, both changing cost and what the model sees, to decide together:

- **A lower compaction target** (e.g. 30% instead of 60%): every pass is smaller, memory per run is smaller, and each step costs less at OpenAI.
- **Keep the conversation at OpenAI** (Responses API, `previous_response_id`): each step sends only what's new, and the per-step row drops to near zero. Compaction would have to work differently. Part of this already happens: with `store` on (OpenAI's default), the provider sends earlier assistant output (reasoning, messages, tool calls) as `item_reference`s, not in full (seen in the recorded requests, `packages/agent/src/testing/fake-openai/recorded/`). What's re-sent in full every step is the user's message and every tool result, which is most of the conversation.

**Settings that go with the fixes:** two worker processes (one per core), `--max-old-space-size` per process (e.g. ~2.5 GB each), and `WORKER_CONCURRENCY` raised to what's measured.

**Not settled by reading the code:** whether each `new Daytona(...)` client (one per sandbox) reuses connections or opens a TLS connection per call; the cost of parsing tool results up to 1 MB; real GC pauses and event-loop lag under load.

## 4. Measuring

`apps/worker/load/` measures it without Daytona or OpenAI. A real worker (`startWorker()`) runs in a child process of its own and is the only process measured. Around it:

| Part | What it is |
|---|---|
| Model | The real `@ai-sdk/openai` provider, pointed at a fake OpenAI server (`OPENAI_BASE_URL`) in its own process. It streams in the format of a recorded OpenAI response (`packages/agent/src/testing/fake-openai/recorded/`), one token per delta at `--tokens-per-second`, so the provider's per-token parsing and per-step serialization are part of the load |
| Sandbox | `LoadSandbox`: 150 ms per call like a remote one; commands take the time their marker says and print that much; files have the size in their name. The diff is empty, so nothing is delivered |
| Runs | Planned from a key in the task: **typical** (25–50 steps), **long** (100–145 steps, larger outputs), **mixed** (a fifth long). Edits go to files read earlier, as the edit tool requires |
| Postgres | A fresh database on the development server (dropped afterwards), behind a proxy adding `--db-latency-ms` per round trip, like Neon |
| Redis | Database 15 of the development Redis, so the development worker never takes the load's work |

Each level starts a new worker with `WORKER_CONCURRENCY` set to the level, queues the runs over `--ramp-seconds`, and stops when they've all finished, the worker exits, its event loop stalls (30 s) or the level times out. Every second it records the worker's heap, RSS, CPU, event-loop delay, GC and database pool, the fake server's CPU, and how far behind live events arrive.

```
pnpm --filter @hobai/worker load --runs 100,250,500,1000 --profile mixed --label baseline
```

Options: `--time-scale` (1 is real time; smaller for a quick check, e.g. `--runs 5,20 --time-scale 0.05`), `--tokens-per-second` (70), `--db-latency-ms` (7), `--ramp-seconds` (30), `--level-timeout-minutes` (50), `--max-heap-mb` (Node's default otherwise, as in production). Results go to `apps/worker/load/results/<time>-<label>/` (gitignored): `samples.jsonl`, `summary.json` and a `summary.md` table. A laptop's numbers compare a fix with what came before it; the capacity numbers come from the same run on the 2 vCPU / 8 GB VPS.

## 5. Baseline on the KVM 2 (2026-11-01)

The production VPS (2 vCPU / 8 GB, no swap), with the production API and worker live beside it. Everything ran in memory-limited Docker containers on a private network: Postgres 16 (1 GB), Redis 7 (256 MB), the harness on `node:24-slim` (4 GB, holding the driver, the worker, the fake OpenAI server and the latency proxy). Neon and Upstash weren't involved.

```
pnpm --filter @hobai/worker load --runs 100,250,500,1000 --profile mixed --max-heap-mb 2240 --label baseline-kvm2
```

| | 100 runs | 250 runs | 500 runs | 1,000 runs |
|---|---|---|---|---|
| Stopped | finished | finished | finished | timed out (50 min) |
| Outcomes | succeeded 100 | succeeded 250 | succeeded 500 | failed 492, succeeded 456, incomplete 35, unfinished 17 |
| Run time p50 / p99 | 361 / 1,607 s | 372 / 1,627 s | 371 / 1,513 s | 1,214 / 1,911 s |
| Heap peak (limit 2,432 MB) | 370 MB | 705 MB | 982 MB | 1,902 MB |
| RSS peak | 695 MB | 1,275 MB | 1,836 MB | 2,682 MB |
| CPU avg / peak (% of a core) | 9 / 53 | 20 / 123 | 35 / 190 | 62 / 185 |
| Event-loop delay p99 peak / max | 11 / 106 ms | 34 / 828 ms | 2,812 / 2,812 ms | 7,588 / 7,588 ms |
| GC pause share / longest | 0.2% / 106 ms | 0.8% / 197 ms | 1.9% / 317 ms | 14.8% / 2,102 ms |
| Pool waiting peak | 0 | 8 | 65 | 895 |
| Event lag p99 / max | 16 / 937 ms | 70 / 1,554 ms | 2.3 / 9.1 s | ≥ 60 s |
| Fake OpenAI CPU peak | 14% | 22% | 35% | 65% |

**What happened, in order:**

1. **Waiting is cheap.** A run spends most of its time waiting on the model or the sandbox; up to 250 runs the worker was busy ~20% of the time.
2. **The start is the worst moment.** All runs are queued within 30 s, so they move in step: they think together, then stream together, then call tools together. Per-token work (§2.2) and per-event INSERTs (§2.3) peak at the same time; at 500 runs the event loop held up to 2.8 s in minutes 3–5 and recovered as the runs drifted apart.
3. **At 1,000 it snowballs.** A slow loop makes every run slower (p50 6 → 20 min), so more runs are alive at once, the heap grows to 1.9 GB, GC takes up to ~90% of a second, and the loop slows further.
4. **Healthy runs are failed.** Lock renewals fall behind (§2.6): 493 jobs failed, and the reaper ended 490 runs as `worker_lost`, most in minutes 13–15. The worker kept running them until then. With them gone, the loop was back to ~100 ms within a minute.
5. **Events are lost.** Queries waiting over 2 s for a connection throw (§2.3): 533 runs have gaps in their timelines.
6. **Long runs weigh on the end.** ~200 long runs left after minute 16 still held the loop ~2 s at a time (§2.5).
7. **35 incomplete** runs hit a limit, most likely the time limit, as everything ran ~3× slower.
8. **17 runs never ended** (§2.7).

`A lost run's work couldn't be kept` (490) comes from the harness: the reaper can't take a diff from a `LoadSandbox`. Ignore it.

**Harsher than production.** The fake OpenAI server (up to 65% of a core), the test Postgres and the driver shared the two vCPUs with the worker; in production they're elsewhere. Memory numbers are the worker's own; CPU and lag numbers are pessimistic.

**Order of work.**

1. A CPU profile of the worker at 500 runs, to split the event-loop time between bottlenecks 2, 3 and 5 before fixing any of them.
2. Bottleneck 7: find what the stuck runs wait on. It matters at any concurrency.
3. Bottlenecks 2, 3 and 5, in the order the profile gives.
4. Bottleneck 6: stop a run's work when its lock is lost.
5. Bottleneck 4 and the settings in §3 (two processes, heap size, `WORKER_CONCURRENCY`).

Each fix is measured against this baseline with the same command.
