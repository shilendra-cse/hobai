# Database Design

> Status: **Accepted** (MVP) · Last updated: 2026-10-30 · Engine: PostgreSQL · ORM: Drizzle

See [architecture.md](./architecture.md) for how these tables are used by the server and worker.

---

## 1. Core concept: Task vs Run

- **Task** — a unit of work. Owns the conversation, the branch and the PR. ("Add dark mode.")
- **Run** — one agent execution against a task. The initial run, a follow-up message and a PR review-comment response are all separate runs on the **same task**: same branch, same PR.

This keeps follow-ups simple: a new run finds its branch and PR on its task, with no run-to-run chains.

---

## 2. Entity relationships

```
user ─┬─< session                       (Better Auth)
      ├─< account                       (Better Auth)
      ├── subscriptions >── plans       (one per user: plan and cycle)
      ├─< github_installations          (installed_by)
      └─< projects >── github_installations
              │
              ├─< onboardings ─< onboarding_events  (setups started from the website)
              ├─< project_environments            (environment config versions)
              │         ▲
              │         └─────────────┐  runs.environment_id (version a run used)
              └─< tasks ─┬─< messages │  (messages.run_id nullable)
                         └─< runs ────┘
                               ├─< run_events
                               └── run_diffs                (one per run)

webhook_deliveries                      (standalone, idempotency)
```

---

## 3. Tables

### Auth (managed by Better Auth)
`user`, `session`, `account`, `verification` — unchanged; keep Better Auth's text ids and shape. `account` holds the GitHub **login** OAuth token only; repository access goes through `github_installations`.

### `plans`
What a plan allows ([billing.md](./billing.md) §2). Seeded with `free` and `unlimited`; later plans are new rows.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `slug` | text unique | `free`, `unlimited`; stable, used by scripts and code |
| `name` | text | shown to users: "Free" |
| `runs_per_cycle` | integer null | null = no limit |
| `concurrent_runs` | integer | tasks running at once |
| `created_at` / `updated_at` | timestamptz | |

Price and included credits are added with paid plans.

### `subscriptions`
Which plan a user is on and their current cycle.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | text FK → `user.id` unique | cascade; one per user |
| `plan_id` | uuid FK → `plans.id` | restrict: a plan in use can't be deleted |
| `source` | enum `subscription_source` (`signup`, `admin`) | how they got this plan; `payment` comes with paid plans |
| `period_start` / `period_end` | timestamptz | the current cycle; a month apart, from the user's own start date |
| `created_at` / `updated_at` | timestamptz | |

Created the first time it's needed (`ensureSubscription`): `free`, cycles counted from the user's `created_at`. When `period_end` has passed, the next request that needs it moves the cycle forward. Usage isn't stored here: it's counted from `runs` in the period.

### `github_installations`
One row per GitHub App installation.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `installation_id` | bigint, **unique** | GitHub's installation id |
| `account_login` | text | user or org login |
| `account_type` | enum `installation_account_type` (`user`, `organization`) | |
| `installed_by_user_id` | text FK → `user.id` | cascade |
| `suspended_at` | timestamptz null | set and cleared by the `installation` webhook (`suspend` / `unsuspend`) |
| `uninstalled_at` | timestamptz null | set when the App is uninstalled; the row is kept, because projects cascade from it. A reinstall clears it. |
| `created_at`, `updated_at` | timestamptz | |

Recorded by the install callback (after checking the user can access the installation) or by the `installation.created` webhook (when the installer has signed in).

### `projects`
A repository connected by a user.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | text FK → `user.id` | owner; cascade |
| `installation_id` | uuid FK → `github_installations.id` | cascade |
| `repo_github_id` | bigint | stable across renames |
| `repo_owner` | text | |
| `repo_name` | text | |
| `default_branch` | text | |
| `archived_at` | timestamptz null | unused; projects are hard-deleted |
| `created_at`, `updated_at` | timestamptz | |

Constraints: **unique (`user_id`, `repo_github_id`)**. Index: (`user_id`, `created_at`).

How to install and check the repository lives in `project_environments` (versioned), not on the project.

### `project_environments`
A project's environment config: how to install the repository and which checks to run ([environment.md](./environment.md)). Created by onboarding; every run replays the active version.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → `projects.id` | cascade |
| `version` | integer | 1, 2, 3… per project |
| `config` | jsonb | the `EnvironmentConfig` (steps, checks, meta) |
| `source` | enum `environment_source` (`detected`, `ai`, `user`, `mixed`) | how this version was created |
| `status` | enum `environment_status` (`active`, `superseded`) | |
| `health` | enum `environment_health` (`ok`, `needs_attention`) | set by runs when a setup step fails or an uncovered project folder appears |
| `health_reasons` | jsonb (string list), default `[]` | why it needs attention, e.g. `admin/ has its own package.json but isn't covered by the environment.` |
| `health_updated_at` | timestamptz null | when health was last set |
| `verified_commit` | text null | commit onboarding verified the config on (from `config.meta.commit`) |
| `created_by_user_id` | text FK → `user.id` null | null when created automatically |
| `created_at` | timestamptz | |

Constraints and indexes:
- **unique (`project_id`, `version`)**
- **Partial unique** on (`project_id`) `WHERE status = 'active'`: at most one active config per project.
- (`project_id`, `created_at`).

Lifecycle: onboarding inserts version N+1 as `active` and marks the previous one `superseded` in the same transaction; restoring reactivates an older version with its health and supersedes the active one, also in one transaction, refused while a setup is in progress.

Code: `DbEnvironmentStore` in `packages/db/src/queries/projects/environments-queries.ts` (`load`, `list`, `save`, `markHealth`, keyed by project id; the same `EnvironmentStore` interface as the CLI's file store). `save` locks the project row, so concurrent saves for one project get versions 1, 2, 3 in turn.

### `tasks`
A unit of work on a project.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → `projects.id` | cascade |
| `created_by_user_id` | text FK → `user.id` | |
| `title` | text | the prompt's first line, then the model's short title from the first run (`task_titled`) |
| `source` | enum `task_source` (`prompt`, `jira`, `notion`) | |
| `source_ref` | text null | e.g. Jira key `ABC-123` |
| `source_url` | text null | |
| `base_branch` | text | |
| `branch_name` | text null | set when the first delivery creates the branch |
| `pr_number` | integer null | set on delivery |
| `pr_url` | text null | |
| `pr_draft` | boolean null | set on delivery from the PR GitHub created (false when the repo can't have drafts); null until then; webhooks don't change it |
| `status` | enum `task_status` (`open`, `pr_open`, `merged`, `closed`) | PR states updated by webhooks |
| `created_at`, `updated_at` | timestamptz | |

Index: (`project_id`, `created_at`).

### `runs`
One agent execution.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | also used as the BullMQ job id |
| `task_id` | uuid FK → `tasks.id` | cascade |
| `trigger` | enum `run_trigger` (`initial`, `follow_up`, `pr_comment`, `retry`) | |
| `status` | enum `run_status` (`queued`, `running`, `succeeded`, `incomplete`, `failed`, `cancelled`) | |
| `stage` | enum `run_stage` (`prepare`, `checkout`, `setup`, `agent`, `verify`, `deliver`) null | current pipeline stage, for UI |
| `sandbox_id` | text null | Docker, E2B or Daytona id; the reaper reconnects to it when the run's worker is gone. Written, like `stage`, as the run goes; retried for up to 30 s, and one that still fails is logged rather than failing the run |
| `environment_id` | uuid FK → `project_environments.id` null | the environment config version this run replayed; set null on delete |
| `model` | text | model the run used |
| `commit_sha` | text null | |
| `checks_passed` | boolean null | lint + tests outcome |
| `summary` | text null | agent's final summary; PR body and follow-up context |
| `error_code` | text null | machine-readable, e.g. `checkout_failed`, `sandbox_busy`, `github_access`, `steps_limit`, `worker_lost`, `lost_in_queue` |
| `error_message` | text null | |
| `input_tokens` | integer, default 0 | |
| `output_tokens` | integer, default 0 | |
| `steps` | integer, default 0 | |
| `cost_usd` | numeric(10,4), default 0 | |
| `queued_at` | timestamptz | |
| `started_at`, `finished_at` | timestamptz null | |

Indexes:
- (`task_id`, `queued_at`)
- **Partial unique** on (`task_id`) `WHERE status IN ('queued','running')` — at most one active run per task, so two workers can never push to the same branch.
- Partial on (`status`) `WHERE status = 'running'` — reaper scans.

### `messages`
The conversation thread on a task.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `task_id` | uuid FK → `tasks.id` | cascade |
| `run_id` | uuid FK → `runs.id` null | run this message triggered or produced; set null on delete |
| `role` | enum `message_role` (`user`, `assistant`, `system`) | |
| `author_user_id` | text FK → `user.id` null | null for assistant / PR-comment authored messages |
| `content` | text | |
| `created_at` | timestamptz | |

Index: (`task_id`, `created_at`).

### `run_events`
Live stream source and audit log.

| Column | Type | Notes |
|---|---|---|
| `run_id` | uuid FK → `runs.id` | cascade |
| `seq` | integer | 1, 2, 3… per run, assigned by the worker |
| `type` | text | `tool_start`, `pr_opened`, … (see `RunEvent` in `packages/shared`) |
| `payload` | jsonb, default `{}` | |
| `created_at` | timestamptz | |

Primary key: **(`run_id`, `seq`)**. A run has exactly one writer, so `seq` is ordered, and gap-free unless a write failed for 60 s and was given up (its events are then missing; later ones keep their numbers); SSE resume is `WHERE run_id = $1 AND seq > $lastEventId`. `text_delta` and `agent_step` events are streamed live but **not** persisted. When a run's worker is gone, the reaper becomes its writer and adds `error` and `done` after the last stored event.

### `onboardings`
One environment setup of a project, started from the website ([environment.md](./environment.md) §3.5).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → `projects.id` | cascade |
| `created_by_user_id` | text FK → `user.id` null | set null |
| `status` | enum `onboarding_status` (`queued`, `running`, `waiting`, `succeeded`, `failed`, `cancelled`) | `waiting` while a question is open |
| `error_code`, `error_message` | text null | e.g. `NO_ANSWER` |
| `open_question_id` | text null | the question it's waiting on |
| `environment_id` | uuid FK → `project_environments.id` null | the version it saved; set null |
| `input_tokens`, `output_tokens` | integer, default 0 | |
| `cost_usd` | numeric(10,4), default 0 | |
| `queued_at` | timestamptz, default now | |
| `started_at`, `finished_at` | timestamptz null | |

Indexes:
- (`project_id`, `queued_at`).
- **Partial unique** on (`project_id`) `WHERE status IN ('queued','running','waiting')`: at most one active setup per project, so starting setup twice returns the one already active.

### `onboarding_events`
Everything a setup does, in order: the setup's live stream and its record. Same shape and rules as `run_events` (one writer, the worker; `seq` ordered and gap-free as for runs; resume with `seq > $lastEventId`).

| Column | Type | Notes |
|---|---|---|
| `onboarding_id` | uuid FK → `onboardings.id` | cascade |
| `seq` | integer | 1, 2, 3… per setup |
| `type` | text | the runner's events, `info`, `question_asked`, `question_answered`, `done` |
| `payload` | jsonb, default `{}` | |
| `created_at` | timestamptz | |

Primary key: **(`onboarding_id`, `seq`)**.

### `run_diffs`
What a run changed, so it survives the sandbox: shown to the user, the content of the PR, and the starting point for resuming a run whose worker died.

| Column | Type | Notes |
|---|---|---|
| `run_id` | uuid PK, FK → `runs.id` | cascade; one diff per run (saving again replaces it) |
| `patch` | text | `git diff` against the run's baseline commit, capped at 1 MB |
| `files` | jsonb | `[{ path, added, removed }]` (`null` counts for binary files) |
| `truncated` | boolean | the patch hit the cap |
| `created_at` | timestamptz | |

Written at the end of every run that changed files, and by the reaper for a run whose worker died (collected from its sandbox).

### `webhook_deliveries`
Idempotency for GitHub webhooks (GitHub retries deliveries).

| Column | Type | Notes |
|---|---|---|
| `delivery_id` | text PK | `X-GitHub-Delivery` header |
| `event` | text | |
| `received_at` | timestamptz | |

Insert first; on conflict, skip processing. If processing fails, the row is deleted again so GitHub's redelivery is processed. Rows older than 30 days can be pruned.

---

## 4. Conventions

- **IDs:** `uuid` for our tables, defaulting to `gen_random_uuid()` in Postgres; Better Auth tables keep text ids, so FKs to `user` are `text`.
- **Time:** every timestamp in our tables is `timestamptz`. Better Auth tables keep the plain `timestamp` columns Better Auth generates.
- **Enums:** Postgres enums for statuses, mirrored as TS unions in `packages/shared`.
- **Deletion:** cascade `user → subscriptions`, `user → projects → tasks → runs → run_events, run_diffs` and `projects → project_environments`, `projects → onboardings → onboarding_events`, and `github_installations → projects`. Projects are hard-deleted (`deleteProjectUnlessBusy`, refused while a run is queued or running); `archived_at` exists but is unused.
- **Naming:** snake_case tables/columns; one kebab-case schema file per table, grouped by domain in `packages/db/src/schema/` (`auth/`, `billing/`, `github/`, `projects/`, `tasks/`, `runs/`; e.g. `runs/run-events-schema.ts`), relations in `relations.ts`, all re-exported from `schema/index.ts`.
- **Shared types:** `packages/shared/src/api/*.ts` mirror these tables for the API and web app; change both together.

## 5. Migrations

Migrations live in `packages/db/drizzle`, are additive, and are generated with `drizzle-kit generate`.

The schema, client, migrations and every query live in `packages/db` (queries in `src/queries/`, one folder per domain like the schema; apps never build queries themselves), shared by the server and the worker ([architecture.md](./architecture.md), [packages/db/README.md](../../packages/db/README.md)). After changing `packages/db/src/schema/`, write a migration with `pnpm --filter @hobai/db generate`; apply migrations with `pnpm migrate`.

The rename to runs (`runs`, `run_events`, `run_id`, `run_*` enums) regenerated `0000_initial` the same way. Since then: `0001_run_diffs`, `0002_installation_uninstalled_at`, `0003_task_pr_draft`, `0004_onboardings`, `0005_plans` (which also seeds `free` and `unlimited`).

**Tests** that need Postgres use `testDatabaseOrSkip` from `@hobai/db/testing`: a fresh, migrated database per run, created next to the development one (or on `TEST_DATABASE_URL`) and dropped afterwards; skipped without Postgres, required in CI (which runs a Postgres service).

## 6. Post-MVP

- `integration_connections` — `user_id`, `provider` (`jira`, `notion`), encrypted tokens, external workspace id, for ticket intake.
- Team access to projects (org members) — projects are single-owner in the MVP; nothing in this schema blocks adding a membership table later.
