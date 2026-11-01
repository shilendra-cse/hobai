# API

> Status: **Built** · Last updated: 2026-10-26 · Code: `apps/server` · Reference: `docs/api/openapi.yaml` (served at `/api/docs` outside production) · Related: [ui.md](./ui.md) (what each screen needs), [github.md](./github.md) §6

The HTTP API behind the web app. The OpenAPI file has every request and response; this page has the rules they share.

## 1. Conventions

- **Base path** `/api`. JSON in and out.
- **Auth:** the Better Auth session cookie from signing in with GitHub. Every route needs it unless marked public; without it: **401**.
- **Success:** `{ status, message, type: "success", data }`.
- **Error:** `{ status, message, type: "error", code?, data? }`. `code` is stable and machine-readable; `message` is for people. A request that fails validation answers **400** with `data` holding zod's field errors.
- **Ids:** hobai's own ids are UUIDs; GitHub's ids (installations, repositories) are numbers and named as such (`installationId`, `repoId`, `githubId`).
- **Dates:** ISO 8601 strings.

## 2. Ownership

Every project, task and run belongs to one user. A route loads it **together with the signed-in user's id**, so someone else's resource and a missing one both answer **404** with the same code: ids of other people's things are never confirmed to exist. Nothing else checks access.

### 2.1 Rate limits

Counted per minute, in the server's memory (one server instance; a shared store comes with a second one). Over a limit: `429 RATE_LIMITED`, "Too many requests. Try again in a minute."

| Limit | Applies to | Counted per | Production | Development |
|---|---|---|---|---|
| Flood guard | every request | address | 1,000 | 10,000 |
| Sign-in | `/api/auth/sign-in/*`, `/api/auth/callback/*` | address | 20 | 200 |
| Signed-in use | every signed-in route | account | 300 | 3,000 |

- A busy user sends 40–60 requests a minute per tab (lists polled every 3 s while something runs), so 300 per account leaves room for several tabs; counting per account means people sharing one network don't share a count.
- `/health` and `/api/github/webhooks` (GitHub's servers, verified by signature) are never limited.
- Addresses come from `X-Forwarded-For`, trusting `TRUST_PROXY` proxies (default 1: the web app's `/api` rewrite; production sets 3, for Vercel's rewrite, Cloudflare and Coolify's proxy).

Security headers come from helmet on every response, with a content security policy in production. The API docs (`/api/docs`, `/api/openapi.yaml`) are served only outside production.

## 3. Error codes

| Code | Status | Meaning |
|---|---|---|
| `GITHUB_SIGN_IN_REQUIRED` | 401 | No usable GitHub token for the user; sign in again |
| `GITHUB_INSTALLATION_NOT_FOUND` | 404 | The installation isn't recorded, was uninstalled, or the user can't access it |
| `GITHUB_INSTALLATION_SUSPENDED` | 409 | The App is suspended on that account |
| `GITHUB_INSTALLATION_REMOVED` | 409 | The App was uninstalled from the project's account; no new work can start |
| `GITHUB_REPOSITORY_NOT_FOUND` | 404 | The repository isn't visible to the user through that installation |
| `PROJECT_NOT_FOUND` | 404 | Not one of the user's projects, or doesn't exist |
| `PROJECT_BUSY` | 409 | A run is queued or running on the project |
| `PROJECT_NOT_SET_UP` | 409 | The project has no environment yet; set it up first |
| `PROJECT_NEEDS_ATTENTION` | 409 | The project's setup needs attention; re-run setup first |
| `TASK_NOT_FOUND` | 404 | Not one of the user's tasks, or doesn't exist |
| `RUN_NOT_FOUND` | 404 | Not a run on one of the user's tasks, or doesn't exist |
| `RUN_ENDED` | 409 | The run has already ended, so it can't be cancelled |
| `ENVIRONMENT_NOT_FOUND` | 404 | The project has no environment version with that number |
| `SETUP_IN_PROGRESS` | 409 | A setup is queued, running or waiting, so a version can't be restored |
| `ONBOARDING_NOT_FOUND` | 404 | The project has never been set up, so there's no setup to answer or stop |
| `ONBOARDING_ENDED` | 409 | The setup has already ended, so it can't be stopped |
| `QUESTION_NOT_OPEN` | 409 | The setup isn't waiting on that question (answered, timed out, stopped, or a different one) |
| `RUN_IN_PROGRESS` | 409 | The user's plan allows that many tasks running at once, and that many are queued or running ([billing.md](./billing.md) §2) |
| `RUN_LIMIT_REACHED` | 429 | The user has used every run in this cycle; `data.resetsAt` says when they're back |
| `DAILY_CAPACITY_REACHED` | 503 | hobai's daily spend cap is reached, for everyone; no new tasks or setups until the next UTC day |
| `RATE_LIMITED` | 429 | Too many requests in a minute (§2.1); the `RateLimit` headers say when the count resets |
| `QUEUE_UNAVAILABLE` | 503 | Work couldn't be queued (Redis unreachable); the task's run or the setup is marked failed (`queue_unavailable`) |

## 4. Resources

| Method | Path | |
|---|---|---|
| GET | `/me/usage` | `{ plan: { slug, name }, runs: { used, limit }, concurrentRuns, periodStart, resetsAt }`; `limit` is `null` on a plan without one ([billing.md](./billing.md) §2) |
| GET | `/github/installations` | The user's installations and the install link ([github.md](./github.md) §6) |
| GET | `/github/installations/:id/repositories` | Repositories the user can access there (most recently updated first), each with its `language` and its `projectId`, or `null` |
| GET | `/projects` | The user's projects, newest first |
| POST | `/projects` | `{ installationId, repoId }` → 201 created, or 200 with the existing project |
| GET | `/projects/:id` | One project |
| DELETE | `/projects/:id` | Removes it with its tasks, runs and environments; GitHub untouched |
| POST | `/projects/:id/onboarding` | Refused with `DAILY_CAPACITY_REACHED` when the daily cap is reached; else records a setup and queues it: 202 `{ onboarding }`; while one is queued, running or waiting, that one is returned |
| GET | `/projects/:id/onboarding` | The latest setup with its open question, or `null` |
| GET | `/projects/:id/onboarding/events` | The latest setup's events as a stream, replayed then live (§6) |
| POST | `/projects/:id/onboarding/answer` | `{ questionId, answer: { option } \| { other } }` → 202; checked against the open question, then handed to the worker |
| POST | `/projects/:id/onboarding/cancel` | 202 `{ outcome: "cancelled" }` for a queued setup, `"stopping"` for a running or waiting one |
| GET | `/projects/:id/environments` | The saved environment versions, newest first |
| POST | `/projects/:id/environments/:version/restore` | Makes an older version active again: 200 `{ environment }` |
| GET | `/projects/:id/branches` | `{ branches, defaultBranch, truncated }`: the repository's branch names from GitHub (with the user's token), the default first, at most 1,000 |
| POST | `/projects/:id/tasks` | `{ prompt, baseBranch? }` → 201 `{ task, run }`, the run queued; refused over the plan's limits or the daily cap (`RUN_IN_PROGRESS`, `RUN_LIMIT_REACHED`, `DAILY_CAPACITY_REACHED`) |
| GET | `/tasks?projectId=&filter=&cursor=` | The user's tasks, newest first, 50 per page, with `nextCursor` and `counts` |
| GET | `/tasks/:id` | A task with its messages and runs |
| GET | `/runs/:id` | One run |
| GET | `/runs/:id/diff` | The run's patch and files, or `null` |
| POST | `/runs/:id/cancel` | 202 `{ outcome: "cancelled" }` for a queued run, `"stopping"` for a running one |
| GET | `/runs/:id/events` | The run's events as a stream (server-sent events), replayed then live (§6) |
| POST | `/github/webhooks` | Public; GitHub's webhook receiver, checked by signature ([github.md](./github.md) §6) |
| GET | `/github/installations/callback` | Public; where GitHub returns after installing the App, redirects to the website ([github.md](./github.md) §6) |

A **project** is its repository (`githubId`, `owner`, `name`), default branch, active environment (`version`, `health`, `healthReasons`, `savedAt`, or `null` until set up) installation (`id`, `accountLogin`, `accountType`, `suspended`, `uninstalled`) and latest setup (`id`, `status`, or `null` before the first).

**Adding a project** checks, in order: the installation is recorded and installed (404), not suspended (409), the user has a GitHub token (401), GitHub shows the user that installation (404) and the repository in it (404). The project belongs to the signed-in user, whoever installed the App; the repository's owner, name and default branch come from GitHub at that moment.

**Removing a project** is refused while one of its runs is queued or running; the check and the delete are one statement, so a run queued in between can't be orphaned.

**Starting work** (a task or setup) needs the App installed and not suspended (409); a task also needs the environment set up and healthy (409). The task's title is the prompt's first line (≤ 120 characters), its base branch the project's default unless given, and its run records the server's `AGENT_MODEL`. The database is written first, then the queue; if Redis can't be reached the run is failed and the request answers 503.

A **task** in a list: `id`, `title`, `project` (`id`, `owner`, `name`), `label`, `baseBranch`, `branchName`, `pullRequest` (`number`, `url`, `draft`, or `null`), `latestRun` (`id`, `status`, `stage`, `error`, `checksPassed`, `filesChanged`, and `summaryLine`, the summary's first line that isn't a heading), `runCount`, `durationMs` and `costUsd` across runs, `createdAt`, `updatedAt` (latest activity). Its **label**, in order: latest run queued → `queued`, running → `working`; PR merged → `merged`, closed → `closed`, open → `pr_open` / `pr_draft`; latest run failed → `failed`, cancelled → `cancelled`; otherwise `no_changes` ([ui.md](./ui.md) §5). Pages are cursored by the last task's id. **Filters** follow the label: `running` is queued or working; `pr` is `pr_open` / `pr_draft`; `done` is the rest. Each page carries `counts` (`all`, `running`, `pr`, `done`) across every page, for one project with `projectId`, whatever the filter. The task detail adds `messages` (oldest first) and `runs` (newest first).

A **run**: `id`, `taskId`, `trigger`, `status`, `stage`, `model`, `summary`, `checksPassed`, `commitSha`, `error` (`code`, `message`, or `null`), `steps`, `inputTokens`, `outputTokens`, `costUsd`, `queuedAt`, `startedAt`, `finishedAt`, `durationMs`, `changes` (`files`, `truncated`, or `null`; the patch comes from `/runs/:id/diff`).

**Cancelling** a queued run marks it `cancelled` directly; a running one is told to stop over Redis (`run-cancel`) and ends `cancelled` once the worker stops it.

A **setup** (onboarding): `id`, `status` (`queued`, `running`, `waiting` for an answer, `succeeded`, `failed`, `cancelled`), `question` (the open one while `waiting`: `id`, `question`, `why`, `options` with the recommended one first, `allowOther`), `environmentVersion` (what it saved), `error` (`code`, `message`; e.g. `NO_ANSWER` after 30 minutes without one), tokens, `costUsd`, `queuedAt`, `startedAt`, `finishedAt`, `durationMs` ([environment.md](./environment.md) §3.5). **Answering** requires the setup to be `waiting` on that question (409 `QUESTION_NOT_OPEN` otherwise), an existing option or, where allowed, 1–2000 characters of your own (400 otherwise); the answer goes to the worker over Redis (`onboarding-answer`). **Stopping** works like cancelling a run, over `run-cancel` with the setup's id.

An **environment version**: `version`, `active`, `source`, `savedAt`, `health`, `healthReasons`, `steps`, `checks`, `decisions` (the questions asked and how they were answered). **Restoring** a version makes it active again with the health it had; the one that was active is kept, and the next setup saves the next number. It's refused while a setup is queued, running or waiting (409 `SETUP_IN_PROGRESS`); an unknown version is 404 `ENVIRONMENT_NOT_FOUND`. The project row is locked as when saving, so a restore and a save take turns.

## 5. Code layout

```
apps/server/src/resources/<name>/
  <name>.routes.ts        paths on the shared ApiRouter
  <name>.controller.ts    parse the request (zod), call services, wrap in the envelope
  <name>.types.ts         zod schemas, response types and mappers
  services/<fn>.service.ts  one function each: rules, HttpErrors, response shapes
```

A route whose handler writes its own response (a stream) wraps it: `api.get(path).authSecure(stream(handler))`. `lib/sse.ts` opens the connection (`openSse`), formats frames, and ends the response; an error before streaming still becomes a normal JSON error.

Services call queries from `@hobai/db`; a query that returns a row or `null` is named `find…`, and the service that turns "not found" into a 404 is named `get…`. Controllers are created from their dependencies (`createProjectControllers({ db, githubToken })`), so tests pass fakes for GitHub and a real test database.

## 6. Run events stream

`GET /api/runs/:id/events` keeps one HTTP response open and writes the run's events to it as they happen ([server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)). In the browser, `new EventSource(url, { withCredentials: true })`.

```
id: 1
data: {"type":"stage_changed","stage":"prepare","runId":"…","seq":1,"ts":"…"}

data: {"type":"text_delta","delta":"Reading the routes","runId":"…","ts":"…"}

: ping

id: 9
data: {"type":"done","status":"succeeded","runId":"…","seq":9,"ts":"…"}
```

- **`data`** is a `RunEvent` (`packages/shared`), the same JSON the worker publishes. **`id`** is its `seq`: stored events are numbered 1, 2, 3…; live-only events (`text_delta`, `agent_step`) have no id and aren't replayed. A `text_delta` carries the text the agent wrote in about 100 ms, not one token; append it as it comes.
- **Resuming:** `Last-Event-ID: <seq>` (sent by `EventSource` itself on reconnect) or `?after=<seq>` starts after that event. Without either, the whole run is replayed.
- **Order of work:** the server listens on the run's Redis channel first, then replays stored events from `run_events` 500 at a time, then forwards live ones. Each stored event is sent once; a jump in `seq` is filled from `run_events`.
- **Ending:** after the `done` event, or as soon as the run has ended without one (e.g. a queued run that was cancelled). A `: ping` every 15 s keeps proxies from closing the connection and re-checks the run's status. `EventSource` reconnects when a stream ends, so clients close it on `done`.
- **Errors** before streaming are normal JSON: 401, 404 `RUN_NOT_FOUND`, 400 for a bad `Last-Event-ID`.
- **`checks_completed`** (`passed`, `checks`: each check's `name`, `cwd`, `command`, `status` and `comparison` with before: `passing`, `failing`, `fixed`, `regressed`, `still-failing`): when the Checks stage has run the checks again after the agent's work. Before is the `setup_completed` event's checks.
- **`task_titled`** (`title`): on a task's first run, the model's short title for it, a few seconds in. The task's `title` is updated at the same time; until then it's the prompt's first line.
- **Redis:** one subscriber connection per server, shared by every viewer of runs and setups; it subscribes to a channel (`run:{id}`, `onboarding:{id}`) for its first viewer and unsubscribes after its last (`lib/event-hub.ts`). The replay-then-live logic is shared too (`lib/event-stream.ts`).

**A setup's events** stream the same way from `GET /api/projects/:id/onboarding/events`: the project's latest setup at the moment you connect (the one `GET /onboarding` returns), with `data` an `OnboardingEvent` (`onboardingId` instead of `runId`; also `info`, `question_asked`, `question_answered`, and `done` with `succeeded`, `failed` or `cancelled`). Setup also reports what it found and each try's results, so the page can show them: `setup_drafted` (`projects`: folder and package manager) and `setup_completed` with a `phase` (`first`, `agent` for each of the setup agent's tries, `final` for the fresh-sandbox check) and each step's and check's command and status. It stays open while the setup waits for an answer, and ends after `done` or once the setup has ended (a setup cancelled before it started has no events). Errors: 404 `PROJECT_NOT_FOUND`, 404 `ONBOARDING_NOT_FOUND` before the first setup.
