# MVP Requirements

> Status: **Accepted** · Last updated: 2026-10-30 · Related: [architecture.md](./architecture.md), [database.md](./database.md)

## 1. Product

hobai is an open-signup web platform where a developer connects their GitHub repositories, describes a coding task, and an autonomous agent completes it in an isolated cloud sandbox and delivers a pull request.

**Problem:** mid-sized, well-defined coding tasks (a feature, a bug fix, a refactor) take hours of a developer's attention even when the "what" is clear. hobai turns a clear description into a reviewable PR without the developer doing the work.

**Context:** personal project, built and dog-fooded by the author first; signup is open to anyone.

## 2. Target user

A developer working on **JavaScript/TypeScript** repositories hosted on **GitHub**, who can describe what they want and will review the resulting PR.

## 3. Scope of work the agent must handle

**In scope — "mid-sized task on a moderately complex repo":**
- Tasks a developer would finish in roughly 1–4 hours: add a feature or endpoint, fix a bug, write tests, refactor a module, update a dependency and fix the fallout.
- Typically touches ~1–15 files.
- Repos: JS/TS, single package or simple monorepo (npm, pnpm or yarn; bun later), up to roughly 100k lines of code.
- Install, lint, type-check and tests runnable inside the sandbox **without external services** (no required databases, cloud credentials or private registries).

**Out of scope for MVP:**
- Languages other than JS/TS. Setup is pluggable per ecosystem ([runner.md](./runner.md)), so languages can be added without redesign; Python is the first planned addition.
- Large or highly complex codebases, polyglot monorepos, tasks spanning multiple repos.
- Tasks needing running external services, secrets or manual setup to verify.
- Vague open-ended work ("improve the app") — the agent may attempt it but quality is not a target.

## 4. User stories (MVP)

### Account & GitHub
| ID | Story | Acceptance criteria |
|---|---|---|
| U1 | As a visitor, I sign up / sign in with GitHub. | One-click GitHub sign-in creates an account; session persists across reloads; sign-out works. |
| U2 | As a user, I grant hobai access to specific repos. | Install the GitHub App choosing all or selected repos; return to hobai with installation recorded; can change selection later on GitHub and hobai reflects it. |
| U3 | As a user, I connect a repo as a project. | Repo picker lists only repos the installation can access; choosing one creates a project; JS/TS check warns if the repo doesn't look like JS/TS. |
| U10 | As a user, I set up my project's environment once through a guided conversation. | hobai detects how to install and check the repo (including repos with several projects, e.g. `frontend/` + `backend/`), tries it, and asks at most 5 multiple-choice questions (2–4 options + free text) only when it can't decide. Every kept step and check has actually run; the final config is re-verified from scratch. I see the result and can save it, or re-run setup. Tasks then reuse the saved config without asking anything. If setup breaks later, the project shows "needs attention" and I can rerun onboarding. ([environment.md](./environment.md)) |

### Tasks
| ID | Story | Acceptance criteria |
|---|---|---|
| U4 | As a user, I describe a task on a project and start it. | Free-text prompt (+ optional base branch, default = repo default branch); task appears immediately with status `queued`. |
| U5 | As a user, I watch the agent work live. | Run view shows stage, tool calls (files read/edited, commands run), streamed reasoning summary; refreshing mid-run resumes without losing history. |
| U6 | As a user, I get a PR when the agent finishes. | PR on branch `hobai/…` with title, summary of changes and lint/type-check/test results; **draft** if checks fail, **ready** if they pass; link shown in the UI. If no changes were needed, no PR and the agent explains why. |
| U7 | As a user, I can cancel a running task. | Cancel stops the agent within ~10 s, sandbox is destroyed, status `cancelled`, no PR pushed. |
| U9 | As a user, I see my history. | Project page lists tasks with status, PR link, duration and cost; task page shows conversation and all runs. |

### Post-MVP (not required for MVP)
Follow-ups on a task (U8: a message starts a new run on the same branch, pushed to the same PR) · PR review comments / `@hobai` mentions triggering runs · Jira and Notion intake · plan approval before editing · team/org project sharing · live app previews · a task assistant to ask questions about a task · shaping the environment by hand · paid plans and billing ([billing.md](./billing.md)).

## 5. Non-functional requirements

### Limits (defaults, configurable by env)
| Limit | Default |
|---|---|
| Max time per run, start to pull request | 45 min |
| Max agent time per run | 30 min |
| Max time per environment setup, waiting for answers included | 45 min |
| Max agent steps per run | 150 |
| Max LLM cost per run | $2 |
| Concurrent runs per user | 1 |
| Runs per user per cycle (a month from signup) | 10 on the free plan ([billing.md](./billing.md) §2) |
| Global concurrent runs | set by worker capacity (start: 3) |

On hitting a per-run limit the agent stops gracefully and delivers a draft PR marked incomplete. A run that reaches 45 minutes before the agent starts fails with "Stopped at the time limit".

### Security
- User code runs **only** inside cloud sandboxes (E2B in production), never on our servers.
- Sandboxes receive only a repo-scoped GitHub installation token (~1 h TTL); no LLM keys, DB or Redis credentials.
- The agent never pushes to the default branch or force-pushes.
- GitHub webhooks are signature-verified; production refuses to start with default secrets.
- Users can only see and act on their own projects, tasks and runs.

### Abuse & cost protection (open signup)
- GitHub-only sign-in for MVP (email/password and Google disabled) — raises the bar for throwaway accounts and is required for the GitHub App anyway.
- Per-user monthly run quota and concurrency limit (above).
- Global daily spend cap; when reached, new tasks are rejected with a clear message.
- Sandboxes always destroyed at run end; auto-stop as backstop.

### Reliability
- A run never stays `running` forever: stalled runs are failed and their sandboxes deleted by the reaper.
- Every run ends in exactly one terminal state (`succeeded`, `incomplete`, `failed`, `cancelled`) with a reason on failure.
- No work is silently lost: if push fails, the error is shown.

### Performance
- Task creation responds in < 500 ms.
- First live event visible in the UI within ~10 s of starting a task.
- Sandbox ready (created, cloned, deps installed) within ~2 min for a typical repo.

### Observability
- Per run: duration, steps, tokens, cost, model, outcome — stored and visible.
- Structured logs with run id across server and worker.

## 6. Success criteria (MVP is "done" when)

1. All MVP user stories (U1–U7, U9, U10) pass their acceptance criteria in production.
2. On the **eval set** (≥ 10 mid-sized tasks across ≥ 3 JS/TS repos: the author's own projects, e.g. DoDesk and BuyerBook, plus small fixture projects):
   - ≥ 60% produce a PR that is mergeable as-is or with light edits.
   - ≥ 80% end with lint, type-check and tests passing.
3. Median run: ≤ 15 min and ≤ $1.
4. The author uses hobai for real tasks on their own projects.

## 7. Product decisions

| Decision | Choice | Rationale |
|---|---|---|
| Model selection | **Platform-controlled for MVP.** Users don't choose a model; the platform picks one per role (agent loop, utility calls) based on eval results and can change it at any time. Each run records the model it ran on. | The platform pays for usage, so cost must stay predictable; quality stays consistent and measurable; no "which model were you on?" support burden. |
| Environment setup | **In the MVP:** a per-repository environment config created once by guided onboarding (rules → try → AI setup agent → multiple-choice questions → verify → approve) and replayed by every task run. | Setup is the foundation of every run; deterministic replay keeps runs fast and predictable, and questions solve the cases rules and AI can't. |
| Environment storage | **Database** (`project_environments`, versioned, one active per project); the CLI uses local files. A config committed in the user's repo is post-MVP. | Zero friction at onboarding; versions, health and per-run audit need the database. |
| Plans | **Free tier only in the MVP:** 10 runs per cycle (a month from signup) on the platform model (GPT-6 Luna), 1 concurrent run, no payments. Paid plans come after launch ([billing.md](./billing.md)). | No payment setup before launch; real usage from free users prices the paid plans. |
| Model choice | **Modes, not models** (paid plans): the user picks Optimized, Balanced or High; a judge LLM picks the model for each run from four categories, and the plan decides which modes are available ([billing.md](./billing.md) §5). No bring-your-own API key. | The cheapest model likely to succeed runs each task, so plans hold far more runs than with one strong model; every run uses the user's credits, so an expensive choice just uses credits faster. The agent already takes the model as a parameter. |

## 8. Open questions

- **Waitlist vs instant access?** Default: instant access with quotas; switch to a waitlist if costs spike.
