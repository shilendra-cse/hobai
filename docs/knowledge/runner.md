# Runner

> Status: **Built** · Last updated: 2026-10-25 · Code: `packages/runner`, `apps/cli` · Related: [agent.md](./agent.md), [sandbox.md](./sandbox.md), [architecture.md](./architecture.md)

The runner executes a coding task end to end: get the repository into a sandbox, prepare it, run the agent, verify the result and deliver it. It contains **no AI logic of its own**: everything it does is deterministic. The AI work happens in `@hobai/agent`, which the runner calls.

The CLI (`apps/cli`) and the worker (`apps/worker`) both use the runner, so a local run behaves exactly like production.

## 1. Stages: `runTask()`

```
sandbox → checkout → setup → baseline → agent → verify → diff → (deliver) → cleanup
```

| Stage | What it does | Status |
|---|---|---|
| sandbox | Create a fresh sandbox | built |
| checkout | Git URL: shallow clone; with a token, it's passed only to that command ([github.md](./github.md) §7). Local folder: copy tracked and untracked-but-not-ignored files, so `node_modules`, build output and `.env` stay out | built |
| setup | Replay the given environment config, or draft one from the repository (rules) and apply it; failed steps flag the environment as needing attention ([environment.md](./environment.md)) | built |
| baseline | Run every check once (passing / failing / broken / timed-out; broken and timed-out are dropped), then commit the state, so files the checks wrote belong to the baseline | built |
| agent | `runAgent()` with the setup result | built |
| diff | Patch and per-file changes against the baseline, taken before verify so the final check run can't add files. Known gap: files the agent's own `run_checks` writes outside `.gitignore` show up in the diff | built |
| verify | Run the checks again and compare with the baseline: passing / fixed / regressed / still failing | built |
| deliver | For a succeeded or incomplete run with changes: list them (files, modes, blob hashes, deletions, the cloned commit as parent, the expected tree) from a snapshot taken before verify, and hand them to the caller's `deliver` callback, which commits outside the sandbox ([github.md](./github.md) §8). Without a callback (CLI, evals) nothing is delivered | built |
| cleanup | Destroy the sandbox, always (unless asked to keep it) | built |

`runTask()` never throws for run problems. It returns a `RunResult`: `status` (the agent's status, or `failed` with `failedStage` and `error` when an earlier stage broke), plus the checkout, setup, agent, verify and diff results that exist, and `delivery` (`branchName`, `sha`) when the changes were delivered. `checksPassed` is the verify outcome (`null` when there are no checks); failing checks don't change the agent's status.

Events: `stage_changed` (prepare, checkout, setup, agent, verify, deliver), `sandbox_created`, the setup and agent events, and `checks_completed` (each check after the agent's work with its comparison) when verify ends. A delivery failure is `failedStage: "deliver"`. A sandbox the provider had no room for, even after the worker waited, is `failedStage: "sandbox"` with `sandboxBusy: true` (the worker records it as `sandbox_busy`); stopped while waiting, the run is `cancelled`.

```
packages/runner/src/
├── index.ts              public API
├── run/                  runTask(), RunResult (+ unit and integration tests)
├── stages/               each stage: index.ts, its files and tests
│   ├── checkout/         clone or local copy; local-files picks what to copy
│   ├── setup/            run-setup.ts: replay or draft, baseline checks, health
│   ├── changes/          baseline commit, diff
│   ├── verify/           re-run checks; compare with the baseline
│   └── deliver/          change-set.ts: the changes handed to the deliver callback
├── environment/          config, build-config, apply, checks, health; draft/ (detectors)
├── onboarding/           runOnboarding() (section 3)
└── lib/                  run-logged (command + full log), shell-quote, git-auth (token for one git command)
```

## 2. CLI: `pnpm agent:setup` and `pnpm agent:run`

`apps/cli` sets repositories up and runs tasks from the terminal, with live progress, the summary, check results and the diff.

```bash
pnpm agent:setup --repo ../my-project                      # once per repository (asks when it can't decide)
pnpm agent:setup --repo ../my-project --show               # the saved environment
pnpm agent:run   --repo ../my-project --task "Add a /health endpoint with a test"
pnpm agent:run   --repo https://github.com/org/repo.git --ref main --task-file task.md --patch out.patch
```

- Configuration in `apps/cli/.env`: `OPENAI_API_KEY`, `AGENT_MODEL` (default `openai:gpt-6-luna`).
- Environments are saved per repository in `~/.hobai/environments/` (last 5 versions; [environment.md](./environment.md)). `agent:run` stops with the `agent:setup` command when a repository has none, and marks the active version as needing attention when setup reports a problem.
- `agent:run` options: `--model`, `--max-steps`, `--max-cost`, `--timeout`, `--environment <file>` (use a file instead of the saved environment), `--no-baseline-checks`, `--patch`, `--keep`, `--json`.
- `agent:setup` options: `--ref`, `--model` (the setup agent's model), `--yes` (recommended answers), `--save <file>` (also write a copy), `--show`.
- Relative paths resolve against the folder the command was run from.
- Ctrl+C cancels cleanly (sandboxes are removed); a second Ctrl+C force-quits.
- Exit codes: `agent:run` 0 succeeded, 2 incomplete, 1 failed (or no environment), 130 cancelled; `agent:setup` 0 saved or discarded, 1 failed, 130 cancelled.
- Your local repository is never modified: the agent works on a copy.
- The code: `apps/cli/src/commands/` (`run.ts`, `setup.ts`), `args/`, `store/` (file store, repo key, saved-environment output), `channel/` (questions); `main.ts` picks the command.

### Terminal UI (`packages/terminal`)

`agent:run`, `agent:setup` and `pnpm eval` share one look:

```
◆ hobai · gpt-6-luna · ../BuyerBook
│ Task: Reject budgetMax below budgetMin
│
◇ Setup ────────────────────────────────────────
│ steps: ✓ install (frontend)   ✓ install (server)
│ checks before: lint (frontend) ✗ failing · typecheck (frontend) ✓
◇ Agent ────────────────────────────────────────
│ ▸ read_file    server/src/…/buyerValidator.ts
│ ▸ run_checks
│   ✓ typecheck (frontend): passed in 3.7s
◒ Agent working · 7 steps · $0.0021 · 0:48     (redrawn in place, terminal only)
…
◇ Result ───────────────────────────────────────
│ Checks: typecheck ✓  lint ✗ still failing
│ 1 file changed (+18 −2)
└ ✓ succeeded · 9 steps · 31.0k tokens (62% cached) · $0.0035 · 3m 12s
```

| Module | Role |
|---|---|
| `style.ts` | colors by meaning (`picocolors`): green works, red broken or failed, yellow already failing or needs attention, dim for paths and times, cyan for tool names; `styleFor(stream)` turns them off outside a terminal or with `NO_COLOR` |
| `layout.ts` · `symbols.ts` · `format.ts` | `◆` intro, `◇` sections, `│` gutter, `└` outro; spinner frames; durations, timers, costs |
| `run-events.ts` | run events → lines (stages, setup results, tool calls, check results, the agent's notes); the CLI's live output and the evals' log files |
| `live.ts` | `LiveArea`: lines redrawn at the bottom (`log-update`) with permanent lines printed above; only in an interactive terminal (TTY, rows > 0, not CI), otherwise just the permanent lines |

- The spinner line follows the run's stage, and while the agent works shows steps and cost from the `agent_step` event.
- `agent:setup` asks its questions with the arrow keys (`@clack/prompts`, `channel/prompt.ts`): the recommended option is preselected, "Something else…" opens a text answer, and the spinner pauses while a question is open. Without a terminal for input, the numbered prompt is used.
- `--json`, log files and piped output contain no colors or redraws.

## 3. Setup

Setup now runs from an **environment config** (steps + checks): either one passed in, which is replayed, or one drafted by the rules and applied. The full design, including onboarding, lives in [environment.md](./environment.md).

```
packages/runner/src/
├── run/                 runTask(): runs the stages in order
├── stages/              one folder per stage, in run order
│   ├── checkout/
│   ├── setup/           run-setup.ts: apply steps, baseline checks, then the baseline commit
│   ├── verify/          rerun checks; compare.ts: passing / fixed / regressed / still failing
│   ├── changes/         baseline commit + diff (taken before verify reruns the checks)
│   └── deliver/         change-set.ts: the agent's changes, handed to the delivery callback
└── environment/         config building blocks, independent of runs (reused by onboarding)
    ├── config.ts        schema: parseEnvironmentConfig()
    ├── build-config.ts  draft + results → EnvironmentConfig
    ├── apply.ts         run steps in order; install alternatives (frozen first, then lenient), keeping what worked
    ├── checks.ts        run checks; classify passing / failing / broken / timed-out
    └── draft/           rules: draft.ts, detector.ts, repo-reader.ts, detectors.ts (registry), node/
```

### Node rules (draft)

The `packageManager` field wins (corepack installs that exact version), then the lockfile, then npm.

| Signal | Manager | Install (frozen) | Alternative |
|---|---|---|---|
| `pnpm-lock.yaml` | pnpm | `pnpm install --frozen-lockfile` | `pnpm install` |
| `yarn.lock` | yarn | `yarn install --frozen-lockfile` | `yarn install` |
| `package-lock.json` / `npm-shrinkwrap.json` | npm | `npm ci` | `npm install` |
| `bun.lock` / `bun.lockb` | bun | not installed (bun is not in the sandbox) | – |
| no lockfile | npm (or the field) | plain install | – |

Checks from `package.json` scripts, run as `<pm> run <script>`: `lint`; `typecheck` / `type-check` / `tsc` / `check-types` (or `tsc --noEmit` for TypeScript projects without one); `test` (ignoring npm's placeholder); `build`. Checks run in their own folder, so the same check can appear once per project (`test (backend)`, `test (client)`).

### Repos with several projects (`draft/node/projects.ts`)

| Shape | Recognized by | Install | Checks |
|---|---|---|---|
| Single project | root `package.json` only | root | root scripts |
| Workspaces | `pnpm-workspace.yaml`, or `workspaces` in the root `package.json` | once, at the root | root scripts; if there are none, each workspace package's scripts in its folder |
| Separate projects | no root `package.json`; first-level folders have one | each folder | each folder's scripts |
| Root only runs tools | the root depends only on tools such as `concurrently`, `turbo`, `husky`, `prettier` | each folder; the root is skipped | each folder's scripts |
| Real root + folders | the root has real dependencies, and folders have their own `package.json` | root and each folder | both |

Each project's package manager comes from its own lockfile, then its own `packageManager` field, then the root's field, then npm. Limits: folders one level deep, at most 8 projects (a note says which were kept), workspace patterns `dir` and `dir/*` only (others get a note; `!` exclusions are ignored). `node_modules` and dot folders are skipped.

Checked against the eval repos (2026-10-18): DoDesk drafts `backend/` and `client/` (all 8 checks pass); BuyerBook drafts `frontend/` and `server/` (pre-existing lint and type errors show as failing; `server` lint is broken because eslint isn't installed there, so it is dropped).

### Non-interactive environment

The sandbox image sets `CI=true` (test runners don't start in watch mode) and `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`. This applies to every command, including the agent's own `bash` calls.

### Onboarding: `runOnboarding()` (`onboarding/`)

```
sandbox + checkout → draft → try (install + checks)
  → problems? (failed step, check not passing, no checks, nothing detected)
      yes → setup agent (packages/agent) with a tryEnvironment that skips installs that already worked
  → final check: the result in a fresh sandbox + checkout
  → show the environment → ask Save / Discard → { status, config, final, agent, notes }
```

| File | Role |
|---|---|
| `run-onboarding.ts` | the flow above; destroys both sandboxes at the end |
| `try-environment.ts` | apply + checks per attempt; reuses steps that already succeeded (same folder and command) |
| `problems.ts` | what sends a setup to the agent |
| `summary.ts` | the environment shown before saving |
| `auto-channel.ts` | `--yes` and evals: always the recommended option, recorded as automatic |

- When the agent doesn't finish, the drafted setup is used and a note says so.
- Checks that are broken or time out in the final check are left out, and checks that behave differently there than in the agent's last try get a note.
- `source` is `detected` when the agent didn't run, `ai` when it did; answers go into `meta.decisions`.
- Saving is the caller's job: the CLI writes its file store; the worker runs with `autoApprove` and saves to `DbEnvironmentStore` (`packages/db/src/queries/projects/environments-queries.ts`).

## 4. Deferred (not in the MVP)

Moved into the MVP by environment onboarding ([environment.md](./environment.md)): several projects per repository, user-editable setup, baseline check run before the agent.

- [ ] Node version selection (`.nvmrc`, `engines`) and toolchain checks; other languages via `mise`
- [ ] yarn 2+ specifics, bun, private registries, git submodules and LFS
