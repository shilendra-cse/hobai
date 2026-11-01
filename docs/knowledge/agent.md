# Agent

> Status: **Accepted** · Last updated: 2026-10-30 · Code: `packages/agent` · Related: [sandbox.md](./sandbox.md), [architecture.md](./architecture.md), [requirements.md](./requirements.md)

The agent is the part of hobai that does the work: an LLM loop that explores a repository, edits code and runs checks inside a sandbox until the task is done. It is a library (`@hobai/agent`); the runner's `runTask()` calls `runAgent()`, and the CLI, the worker and the evals all go through `runTask()`. The worker also calls `titleTask()` directly (section 10). A second agent, the setup agent (section 9), shares the same loop.

## 1. How it fits

```
runTask (runner; called by CLI / worker / evals)
  └─ runAgent({ task, ctx, model, setup, limits, emit, signal })
       ├─ prompt:  system rules + repository context (built once per run)
       ├─ loop:    streamText ⇄ tools, until finish_task / limit / cancel / failure
       │     └─ tools ─► Sandbox interface ─► DockerSandbox / E2BSandbox / DaytonaSandbox
       └─ returns AgentResult { status, summary, usage, steps, messages, … }
```

- The LLM only sees tool **names, descriptions and input schemas**. It sends back a tool name and arguments; the AI SDK looks the tool up and calls its `execute` function.
- Tools run against the run's sandbox through `ToolContext`, which our code binds when the tools are created. The model never supplies or sees the context.
- The agent never commits, pushes or opens PRs. Delivery is the caller's job.

## 2. Code layout

```
packages/agent/src/
├── index.ts                  public API (re-exports each module)
│
│   shared by both agents
├── loop/
│   ├── run-loop.ts           the flow for any agent: segments → finished / failed / cancelled / limit / nudge
│   ├── run-segment.ts        one streamText call: events, infra-error abort, message snapshot
│   ├── agent-result.ts       AgentStatus, LoopResult, AgentResult, finish tool input lookup
│   ├── compaction.ts         cache-friendly context compaction
│   ├── events.ts             AI SDK stream parts → RunEvent
│   ├── limits.ts             default limits and the messages the model sees
│   ├── deadline.ts           createDeadline: a time limit that can pause
│   └── errors.ts             infrastructure-error detection
├── tools/
│   ├── core/                 context, run-tool, tool-error, workspace-path, output-log
│   └── list-files/ · read-file/ · search/ · bash/
├── prompt/repository.ts      tree, package.json, README excerpt, AGENTS.md
├── model/
│   ├── catalog.ts            the models the platform may run (edit this to add one)
│   ├── types.ts              ModelSpec, ModelPricing
│   ├── resolve-model.ts      "openai:<id>" → AI SDK model via the provider registry
│   └── usage.ts              tokens (input / cached / output) → cost
├── lib/                      truncate, shell-quote, lines
├── testing/mock-model.ts     scripted fake model
│
│   one folder per agent: its run function, prompt and own tools
├── task-agent/
│   ├── run-agent.ts          runLoop with the task prompt, tools and finish_task
│   ├── prompt/               system-prompt.ts (fixed rules) · repo-context.ts (repository + setup section)
│   └── tools/                createTools() · edit-file/ · write-file/ · run-checks/ · finish-task/
├── setup-agent/              section 9
└── title/title-task.ts       a task's short title (section 10)
```
Each tool folder holds `<tool>.ts`, `description.ts` and its tests.

Tests sit next to the code: `*.test.ts` need nothing, `*.integration.test.ts` need Docker.

## 3. Tools

| Tool | What it does |
|---|---|
| `list_files` | Indented tree (depth 1–5, max 500 entries), skipping `node_modules` and `.git` |
| `read_file` | Line-numbered content (`12│ code`), 2,000 lines per call, `offset` to continue; rejects binary files |
| `search` | ripgrep with `path` / `glob` / `ignoreCase`; respects `.gitignore`; max 100 matches |
| `edit_file` | Exact replacement; `oldString` must match once (or `replaceAll`); returns the edited lines |
| `write_file` | Create or overwrite a file; parent folders created |
| `bash` | Shell command in `/workspace`; 2 min default, 10 min max; stdout + stderr combined |
| `run_checks` | Runs the repo's checks (from setup), each in its own folder; ✓/✗ per check plus the end of failing output |
| `finish_task` | Ends the run with an optional short title (the commit subject and PR title) and a summary (used in the PR description) |

Shared rules:
- **Paths:** resolved against `/workspace`; anything outside is refused; writes inside `.git` are refused. The container is the real security boundary.
- **Read before edit:** editing or overwriting a file requires reading it first in the same run.
- **Output size:** every result is capped at 30,000 characters, keeping whole lines from the start (40%) and end (60%).
- **Full output kept:** `bash` and `run_checks` save complete output to `/tmp/hobai/logs/NNNN-*.log` (outside the repo). Shortened results say where the log is; the agent can `search` or `read_file` it.
- **Errors:** expected failures return `Error: …` to the model so it can retry. Infrastructure failures (sandbox gone) stop the run.

## 4. The loop

`runAgent()` runs one or more **segments**. A segment is a single `streamText` call in which the model takes steps (one or more tool calls each) until something stops it. After each segment the loop decides:

| Situation | Outcome |
|---|---|
| Model called `finish_task` | **succeeded**, with its summary |
| A tool hit an infrastructure error (sandbox gone) | **failed** immediately; no more model calls |
| Caller aborted the signal | **cancelled** |
| Model provider failed after 3 retries | **failed** |
| Step, time or cost limit reached | **wrap-up**: one forced `finish_task` step, then **incomplete** with an honest summary |
| Model stopped without `finish_task` | **nudge** ("continue, or call finish_task"), up to 2 times; then **failed** |

Details:
- **Limits** (defaults, override per run): 150 steps, 30 minutes, $2. The cost check runs after each step, so the last step plus the wrap-up can go slightly over. In a run, the runner shortens the time limit to what's left of the run's 45 minutes.
- **Wrap-up** has its own 2-minute budget and forces the `finish_task` tool (`toolChoice`).
- **Messages** of completed steps are kept even if a segment is aborted mid-step.
- **Events:** the loop emits `tool_start`, `tool_end` (output preview ≤ 2 KB), `text_delta`, and after every model step `agent_step` (steps so far and cost so far; streamed, not persisted). It does not emit `done`/`error`: the agent loop ending is not the run ending (checks and delivery follow), so the caller reports the outcome.

### Result

```ts
AgentResult {
  status: "succeeded" | "incomplete" | "failed" | "cancelled";
  title: string | null;        // from finish_task: first line, null when none
  summary: string | null;      // from finish_task
  error?: string;              // why it failed or ended early
  limitReached?: "steps" | "time" | "cost";
  steps, durationMs, model, compactions;
  usage: { inputTokens, cachedInputTokens, outputTokens, costUsd };
  messages;                    // full transcript
}
```

`incomplete` is its own run status; delivery opens it as a draft PR marked incomplete.

## 5. Prompt

- **System prompt** = fixed rules (`AGENT_RULES`) + repository context. It is built once per run and never changes, so together with the tool definitions it forms a stable prefix the provider can cache.
- **Repository context:** file tree (2 levels), `package.json` (name, scripts, dependencies), first 80 lines of the README, `AGENTS.md` (capped at 8,000 characters). Missing files are skipped.
- **Setup section:** the setup steps (✓, or FAILED with the log path and the end of the error), the checks for `run_checks` with their status before the agent's changes (passing / already failing / broken / timed out), and setup notes. When a check was already failing, the agent is told not to fix it unless the task asks. Passed in as `runAgent({ setup })`; see [runner.md](./runner.md) and [environment.md](./environment.md).
- **First user message** = the task.

## 6. Context compaction

Every step resends the whole conversation. Long tasks would overflow the context window, and cost grows with every step.

- **Trigger:** estimated prompt size (characters ÷ 4) above **60%** of the model's context window.
- **Action:** in one batch, replace the content of old tool results with a one-line note (`[Output of read_file src/app.ts removed to save context (9,031 characters). Run the tool again if you need it.]`) until the prompt is under **40%**. Kept: the task, every tool **call**, the model's own text, and the last **10** steps in full (fewer, down to 3, if those steps are huge).
- **Watermark:** the cut-off is remembered and only moves at the next compaction. Between compactions every request starts with an identical prefix, so the provider's prompt cache keeps hitting. Compaction costs one cache miss each time it runs, which is rarely.
- **Cost of the check:** it runs before every step, so it doesn't re-read the conversation: each message is measured, and compacted, once, and a running total gives the size ([worker-capacity.md](./worker-capacity.md) §2.5).
- No LLM summarization: replacing results is free, deterministic and testable, and the agent can re-read anything it needs.

## 7. Models

Model choice is **platform-controlled** for the MVP (see [requirements.md §7](./requirements.md)): users don't pick a model.

- **Catalog** (`model/catalog.ts`): the only models that can run. Each entry has an id (`openai:<model id>`), context window and prices (input, cached input, output per 1M tokens). Unknown ids are rejected, because the cost limit needs prices.
- **Resolution:** `resolveModel(id)` creates the model through the AI SDK provider registry. API keys come from the environment (`OPENAI_API_KEY`).
- **Who picks:** `runAgent` receives an already resolved model. The CLI and worker choose it (from `AGENT_MODEL`), so per-run model choice on paid plans ([billing.md](./billing.md)) can be added later without changing the loop.
- **Current catalog:** `openai:gpt-6-luna` ($0.10 input / $0.01 cached / $0.50 output per 1M tokens). Its `contextWindow` is set to 272K, not the real 1.05M, because prompts above 272K are billed at double rates; compaction then keeps prompts well under that threshold.
- **Usage:** input, cached input and output tokens are tracked per step; cost is computed from catalog prices. Tokens are the source of truth if prices change.

To add a model: add a catalog entry with values from the provider's model and pricing pages, then select it with `AGENT_MODEL`.

## 8. Testing

- **Fake model** (`testing/mock-model.ts`): a scripted LLM that replays tool calls and text per call, with configurable usage, delays and errors. No network, no cost.
- **Fake sandbox** (`packages/sandbox/src/testing/fake-sandbox.ts`, imported from `@hobai/sandbox/testing`): in-memory files and scripted `exec`.
- **Loop tests** cover finishing, real tool execution, event order, the prompt sent, nudges, all three limits with forced wrap-up, cancellation, sandbox loss before and during the run, provider errors, and recovery from tool errors.
- **Integration tests** run tools against a real `DockerSandbox`.

## 9. Setup agent

Used only during environment onboarding ([environment.md](./environment.md)): it gets the setup the rules drafted and the results of trying it, makes the repository installable and checkable, asks the user when it can't decide, and returns the final steps and checks.

```
runSetupAgent({ sandbox, model, initial: { proposal, result, notes }, tryEnvironment, channel, limits })
  → SetupAgentResult { status, proposal, notes, decisions, usage, … }
```

```
packages/agent/src/setup-agent/
├── run-setup-agent.ts   runLoop with the setup prompt, tools and finish_setup
├── prompt.ts            rules + the brief (drafted setup, its results, the rules' notes)
├── schema.ts            steps + checks input shared by try_environment and finish_setup
├── format.ts            try results → text for the model
├── context.ts           tryEnvironment, channel, questions asked, decisions
└── tools/  try-environment/ · ask-user/ · finish-setup/
```

| Tool | What it does |
|---|---|
| `list_files`, `read_file`, `search`, `bash` | explore and try commands (the task agent's tools) |
| `try_environment` | runs a whole setup through the runner's function and returns each status with the end of its output |
| `ask_user` | a question with 2–4 options (first = recommended) through the `UserChannel`; only options it can carry out in the sandbox (none needing a host a download already failed to reach); free-text answers allowed; at most 5; each answer is recorded as a decision (`auto` when no one was asked) |
| `finish_setup` | the final steps, checks and notes; ends the run |

- No `edit_file` / `write_file`: the setup must work from a clean checkout, so the repository is never changed. The prompt also says anything installed by hand with `bash` is lost.
- Failing checks: the agent decides whether the failure is in the code (kept as already failing) or in the environment (fixed, or the user is asked).
- Installing packages the repository doesn't declare (e.g. a linter missing from `package.json`) is the user's decision: the agent asks, recommends leaving the check out, and pins exact versions if the user wants the install.
- Try results list every status first and the output of failed steps and checks after, so the overview survives truncation; steps reused from an earlier try show "already done".
- Limits: 40 steps, 20 minutes (installs alone can take minutes), $0.20. The 20 minutes pause while a question waits for an answer.
- The package doesn't depend on the runner: `tryEnvironment` and the channel are passed in.

## 10. Task titles

`titleTask(model, prompt, { signal?, timeoutMs? })` asks the model once for a task's title: 3 to 6 words, sentence case, starting with a verb, naming the change rather than the request ("Add AWS skills to the profile"). The answer is tidied by `cleanTitle` (first line only; quotes, a `Title:` prefix and a trailing full stop removed; cut at a word within 60 characters). It never throws: a failed or unusable answer, or none within 10 s, gives `title: null`, and the caller keeps the title it has. It returns the call's `usage`, so its cost counts towards the run.

## 11. Known limitations / TODO

- [ ] Cost limit is checked between steps, so a run can slightly exceed it.
- [ ] Token estimate for compaction is a character heuristic.
- [ ] Utility model for cheap side tasks (PR titles/descriptions), per-run model choice (paid plans) and fallback models are post-MVP.
- [ ] LLM-based summarization of old context, if evals show the agent losing track on long tasks.
