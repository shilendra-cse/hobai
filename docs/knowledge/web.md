# Web app

> Status: **Accepted** (Phase 4) · Last updated: 2026-10-29 · Code: `apps/web` · Related: [ui.md](./ui.md) (screens, states) and its [design canvas](https://claude.ai/artifact/7CrGGxQmeSht3KyDnahRUr), [api.md](./api.md) (the API it calls), [development-plan.md](./development-plan.md)

How the web app is built: the stack, how it talks to the API, how the code is organized, and the order we build it in. **What** each screen shows is in ui.md; this file is **how**.

## 1. Stack

| | |
|---|---|
| Framework | **Next.js** (App Router), React 19, TypeScript |
| Styling | Tailwind v4 with our design tokens (§7) |
| Components | shadcn/ui on Radix, kept in `components/factory/` and only used through our atoms (§6) |
| Data | **axios** for HTTP, **TanStack Query** for loading and caching, the browser's **EventSource** for live run events |
| Auth | Better Auth's React client, GitHub sign-in |
| State | server data in TanStack Query, filters in the URL, the theme in next-themes; **Zustand** only once a real need shows up |
| Tests | Vitest + Testing Library; Playwright for the end-to-end journey |

**How Next.js is used.** Public pages (landing, sign-in) are rendered on the server: fast and readable by search engines. Everything behind sign-in is client-side React: the screens are live and change constantly, the API is its own Express server, and server rendering would add a second place for bugs without helping. So no server components fetching data and no server actions.

## 2. Talking to the API

```
browser ──► localhost:3000/api/*  ──(next.config rewrites)──► localhost:3001/api/*
```

The browser only ever calls `/api/...` on the web app's own address; Next forwards it to the API. To a browser, `:3000` and `:3001` are different websites, and it limits what one may do with another: cookies aren't sent across and every request needs CORS permission. Forwarding makes the API part of the web app's own site, so the session cookie just works and there's no CORS. In production it's one domain.

**Sign-in** goes through the same door: `BETTER_AUTH_URL` is the web app's address and the GitHub App's callback URL is `http://localhost:3000/api/auth/callback/github`, so the session cookie is created for the web app's address.

**Security.** Nothing new is exposed: only `/api/*` is forwarded, and the API still checks the session on every request. The cookie stays on one site (`httpOnly`, `SameSite=Lax`), and Better Auth trusts only the web app's origin (`FRONTEND_URL`). The forwarding target comes from `API_URL` (server-side only).

**The client** (`lib/api/client.ts`):
- One axios instance, `baseURL: "/api"`. Responses: the `{ status, message, type, data }` envelope is unwrapped, callers get `data`. Errors: a typed `ApiError` with the API's `status`, `code` (e.g. `PROJECT_NOT_SET_UP`) and `message`; a **401** sends you to `/signin`.
- The endpoint functions live with their domain, in `features/<domain>/api.ts`: one small typed function per endpoint (`startTask(projectId, input)`, `cancelRun(runId)`…).
- Live run events don't go through axios (§5).

## 3. Loading and caching data

TanStack Query wraps the axios functions in hooks per domain (`useProjects()`, `useTasks(projectId)`, `useTask(id)`, `useStartTask(projectId)`…), in `features/<domain>/`. Pages use the hooks, never axios directly. It avoids fetching the same thing twice, refreshes when you come back to the tab, polls while a run is in progress (Inbox, project tasks), and refreshes lists after a change (a task created → the Inbox refreshes).

## 4. The API contract (`@hobai/shared`)

Request schemas and response types live in one shared package, organized by domain like the server's `resources/`:

```
packages/shared/src/api/
  envelope.ts      ApiSuccess<T>, ApiErrorBody, the error codes
  github.ts        GitHubInstallation, GitHubRepo
  projects.ts      createProjectSchema, projectParamsSchema · ProjectResponse
  tasks.ts         createTaskSchema, listTasksQuerySchema, taskParamsSchema · TaskListItem, TaskDetail, TaskLabel, CreatedTask
  onboarding.ts    answerOnboardingSchema · OnboardingResponse, OnboardingEvent, OnboardingAnswer
  runs.ts          runParamsSchema, afterSeqSchema · RunResponse, RunDiff, CancelOutcome
  events.ts        RunEvent and its variants
```

- **Requests:** zod schemas. The server validates with them; the web can validate forms with the same rules.
- **Responses:** types. The server's mappers must return them and the web's axios functions are typed with them, so a field renamed on the server breaks the web's build, not its users.
- One file per domain is the readable reference for that part of the API; OpenAPI stays the published one.
- Types disappear at build time, so nothing extra ships. The older draft types in `packages/shared/src/types/api.ts` (`Project`, `Task`, `CreateTaskRequest`…) aren't used anywhere and are replaced.

## 5. The live run view

The screen you watch while the agent works. Its data arrives as a stream of small events ("stage changed", "started reading app.ts", "edited routes.ts", "done") over `GET /api/runs/:id/events` ([api.md](./api.md) §6). Two separate pieces:

1. **The connection, `useRunEvents(runId)`:** opens an `EventSource`, collects events into a list as they arrive, reconnects with `Last-Event-ID` (the browser does it), closes on `done`. It only receives.
2. **The translator, a pure function:** reads the list and works out what to show: stage states, tool calls grouped into "Explored the code · 6 files", edits with +/−, commands with results, the latest reasoning line, the PR. It only understands.

The translator is the hard logic of the main screen; as a plain function it's tested with lists of fake events, no browser or server. The run card just draws its result. (Detailed with a diagram in step 6.)

## 6. Code structure: atomic design

```
apps/web/
  app/                      pages: a route + data hooks + a template
    (marketing)/page.tsx    landing
    (marketing)/pricing · devlog · devlog/[slug] · devlog/rss.xml
    signin/page.tsx
    (app)/layout.tsx        the app shell, for signed-in pages
    (app)/welcome · inbox · new
    (app)/projects/new · [id] · [id]/environment · [id]/settings
    (app)/tasks/[id]
  components/
    factory/                library components as generated (shadcn/Radix); never edited, only used by atoms
    atoms/                  our wrappers: our names, props and styling (Button, Input, Badge, Icon, Spinner, Logo…)
    molecules/              a few atoms doing one job (TaskStatusBadge, SetupStatusBadge, PullRequestCard, DiffView, NavItem…)
    organisms/              complete sections (Sidebar, RunCard, QuestionCard, ProjectTaskTable, InboxList…)
    templates/              page layouts with slots (AppShell, CenteredLayout, MarketingLayout, ProjectTabs)
  features/<domain>/        data only: endpoint functions, query hooks, the run-events translator (account, github, projects, onboarding, setup, tasks, runs); devlog reads the posts from content/devlog
  content/devlog/           devlog posts, one MDX file each ([devlog.md](./devlog.md))
  lib/                      api/client.ts (axios), query client, auth client, routes
  middleware.ts             the sign-in guard
```

- **Atoms through templates never fetch data.** They take props and render; only pages, through `features/` hooks, load data.
- **Library code stays in `factory/`.** Only atoms import it (or `@radix-ui/*`); the rest of the app knows only our atoms' API. Swapping a library changes atoms only. ESLint enforces it, like the query layer on the server.
- Each layer imports only from the layers below it.

## 7. Look and feel

- **Tokens:** the canvas's colours named once in `app/globals.css`, with a light and a dark value each: surfaces, borders, text (3 levels), the **mono accent** (black in light mode, white in dark), and status colours (`ok`, `warn`, `err`, `merged`, with soft background and border variants), plus `add` / `del` for diffs. They map onto shadcn's variables, so every atom picks them up. Components use names, never raw colours.
- **Fonts:** Geist and Geist Mono through `next/font`. **Icons:** lucide. **Logos:** `public/brand/` (black on light, white on dark).
- **Theme:** follows the system, switchable in the account menu (next-themes).
- **Motion and glow** ([ui.md](./ui.md) §2): plain CSS in `app/globals.css` (`grid-backdrop`, `glow`, `beam`, `sheen`, `rise`, `reveal`), with one reduced-motion block that stops them all; no animation library. Atoms `GridBackdrop` and `Glow` place the backdrop. Each step's screens apply them as they're built: the beam and sheen on what is working, rise on what arrives, the glow on the page's primary action, hover on what opens.
- **Diffs:** our own small renderer for the Changes tab.
- **Layout:** flexbox by default; CSS grid only where a layout really needs two-dimensional alignment (e.g. a table-like set of rows and columns that must line up).

## 8. Sign-in and routing

- `middleware.ts`: without a session cookie, any `(app)` route redirects to `/signin?next=…`. Any 401 from the API also sends you to `/signin`.
- Signed in, `/` stays the landing page, with **Open hobai** in place of Sign in. `/signin` sends you on to `next`, else `/inbox`.
- After signing in you go to `/inbox`; the Inbox sends you to `/welcome` until you have a task.
- GitHub's App install callback returns to `/projects/new` when the install link carried `state=add-repo`, else `/welcome?github=…` (signing in first returns there too).

## 9. Testing

- **Vitest + Testing Library:** atoms through organisms, query hooks against a faked API, and above all the run-events translator.
- **Playwright** (step 9, §19): the whole journey, sign in → setup → task → live events → PR → Inbox, with GitHub faked and a scripted model. Run on demand with `pnpm e2e`, not in CI.
- Every step is also checked by running the app: screenshots against the canvas, light and dark, and at phone width.

## 10. How we build: step by step through the user's journey

Each step: **requirements first** (written here, approved) → built bottom-up within the step (only the atoms and molecules it needs) → checked against the canvas → committed in small batches.

| Step | At the end you can | Branch | Status |
|---|---|---|---|
| 1. Sign in | open the landing page, sign in with GitHub, arrive in the app | `feat/web-sign-in` | merged |
| 2. Connect GitHub | see the welcome checklist, install the App, come back | `feat/web-connect` | merged |
| 3. Add a repository | pick a repo; it becomes a project in the sidebar | `feat/web-add-repo` | merged |
| 4. Set up the environment | watch setup, answer its question, save; onboarding events stored server-side | `feat/web-onboarding` | merged |
| 5. Start a task | describe a task and start it | `feat/web-new-task` | merged |
| 6. Watch it work | the live run view: stages, activity, diff, terminal | `feat/web-run-view` | merged |
| 7. Get the PR | the finished run, PR card, cancel, every outcome | `feat/web-outcomes` | merged |
| 8. Find your work | Inbox, project page, history | `feat/web-inbox` | merged |
| 9. End to end | the whole journey in Playwright, on demand (`pnpm e2e`, not in CI) | `feat/e2e` | merged |

## 11. Step 1: Sign in (requirements)

**Goal:** a visitor opens the landing page, signs in with GitHub and arrives in the app shell; everything underneath (contract, tokens, client, guard) is in place for the steps after.

**Screens** (canvas: Landing, Sign in; the shell from any app screen):
- **Landing `/`:** as drawn: header (logo, How it works, Security, Sign in, Get started), hero with "Sign in with GitHub", product preview, how it works, security points, closing call to action, footer. Signed in, it stays: **Open hobai** goes into the app.
- **Sign in `/signin`:** the card as drawn; "Continue with GitHub" starts Better Auth's GitHub sign-in and returns to `/welcome` (since the Inbox: to `next`, else `/inbox`, §8). States: default, signing in (button busy), failed (`?error=…` → the error box).
- **App shell `(app)/layout`:** sidebar (logo, New task, Inbox, Projects with "No projects yet", account menu with avatar, name, theme switch and Sign out) and the content area. Pages behind it in this step: `/welcome` with only its greeting ("Welcome, <name>"); step 2 fills it in.

**Underneath:**
- The shared contract (§4): request schemas and response types move from the server into `packages/shared/src/api/`; the server uses them; the unused draft types go.
- `next.config.ts` rewrite of `/api/*` to `API_URL` (default `http://localhost:3001`); the auth client on the same origin, no hard-coded URLs.
- `lib/api/client.ts` (envelope, `ApiError`, 401), the TanStack Query provider.
- Tokens, fonts, theme (§7); the old dot-matrix background and sign-in styling go.
- `components/factory/` holds the shadcn primitives; atoms for this step: Button, Logo, Icon, Avatar, Spinner, Link, Menu; ESLint rule for the layers.
- `middleware.ts` (§8).

**API used:** Better Auth's `/api/auth/*` (sign in with GitHub, get session, sign out), through the rewrite.

**Done when:**
1. `/` matches the canvas in light and dark and at phone width, with no horizontal scroll.
2. "Sign in with GitHub" goes to GitHub and comes back to `/welcome` inside the shell, with your name and avatar in the account menu.
3. A reload keeps you signed in; Sign out returns you to `/`; opening `/welcome` signed out sends you to `/signin`; opening `/signin` signed in sends you into the app.
4. In the browser's network tab, every request goes to `localhost:3000`; nothing calls `:3001` directly.
5. Importing `components/factory/*` or `@radix-ui/*` outside `components/atoms/` fails lint.
6. Tests cover: the axios client (envelope unwrapped, `ApiError` with `code`, 401 → `/signin`), the middleware's redirects, and the atoms built.
7. The server's tests, lint and type-check still pass with the shared contract.

**Batches** (proposed):
1. **Shared contract:** `packages/shared/src/api/` by domain; the server's resources import from it; the old draft types removed.
2. **Plumbing:** the rewrite and `API_URL`, the axios client, the Query provider, the auth client on the same origin, `middleware.ts`; tests.
3. **Look:** tokens, fonts and theme; `factory/` and the step's atoms; the ESLint layer rule.
4. **Public pages:** landing and sign-in from the canvas.
5. **App shell:** the AppShell template, sidebar, account menu (theme, sign out), `/welcome` greeting; screenshots against the canvas.

## 12. Connect GitHub (requirements)

**Goal:** `/welcome` shows the first-run checklist; "Install on GitHub" goes to GitHub and you come back to `/welcome` with that step done.

**Screen `/welcome`** (canvas: Welcome):
- The greeting ("Welcome, <first name>" and the subtitle), then a checklist of 4 steps. Done steps are ticked, the current one shows its button and hint, later ones are muted:
  1. **Install the GitHub App**: done when you have any installation (`GET /github/installations`); the button goes to its `installUrl`.
  2. **Add a repository**: done when you have any project (`GET /projects`); "Choose a repository" → `/projects/new`.
  3. **Set up its environment**: done when any project has an environment; → that project's environment page.
  4. **Describe your first task**: done when any task exists (`GET /tasks`, first page); → `/new`.
- The note about JavaScript and TypeScript repositories under it.
- **States:** loading (a skeleton of the checklist), an API error (an alert with Try again), GitHub sign-in expired (the API's 401 `GITHUB_SIGN_IN_REQUIRED` → `/signin?next=/welcome`, as any 401).
- **Back from GitHub**, `/welcome?github=…` shows a notice, then the parameter is removed from the address:
  - `installed`: "GitHub App installed."
  - `requested`: "Installation requested. An owner of the organisation needs to approve it."
  - `cancelled`: "Installation cancelled."
  - `not-found`: "We couldn't find that installation on your account."
- **Touches** ([ui.md](./ui.md) §2): the backdrop goes into the AppShell once, below any top bar, so every app page has it; on `/welcome` the greeting and checklist rise in, and the current step's button has the glow.
- The sidebar's Projects list stays "No projects yet." here; it lists projects once Add a repository exists.

**Steps in place** (added after trying the first version, [ui.md](./ui.md) Welcome): the current step opens inside the checklist instead of linking away. Step 2 holds the repository picker (`useRepositoryPicker`, shared with `/projects/new`; on Welcome it loads repositories only while step 2 is open, and its install link returns to Welcome); once added, step 2 reads "<name> added." and step 3 opens. Steps 3 and 4 open in place too: the live setup card and the task box.

**Getting started card:** in the sidebar until the four steps are done, from the same checklist data; "N of 4", a progress bar, "Next: …", linking to `/welcome`; hidden on `/welcome`.

**Server:** the install callback returns to `/welcome?github=<outcome>`, and sends someone signed out to `/signin?next=/welcome`.

**Underneath:**
- `features/github/` `useInstallations()`, `features/projects/` `useProjects()`, `features/tasks/` `useHasTasks()`: an axios function and a Query hook each, typed by the shared contract.
- `features/onboarding/checklist.ts`: a pure function from those three results to the 4 steps (done, current or todo, and where each button goes).
- Molecule `checklist-step`, organism `welcome-checklist` (with its loading and error states); the `Alert` atom for the notices.

**Done when:**
1. A new user sees step 1 current; installing on GitHub brings them back to `/welcome` with "GitHub App installed." and step 2 current.
2. Cancelling on GitHub, or requesting an organisation's approval, comes back with the right notice.
3. The checklist matches the canvas's Welcome board (steps 1 and 2) in light and dark and at phone width.
4. Tests cover the checklist function for each combination, the step and checklist components with their states, the notices and removing the parameter, and the callback's redirects.
5. The web and server tests, lint and type-check pass.

**Batches:**
1. **Server:** the callback's redirects and their test; these requirements.
2. **Data:** the three query hooks and the checklist function, with tests.
3. **Screen:** the checklist components, the notices, the AppShell backdrop and `/welcome`, with tests.

## 13. Add a repository (requirements)

**Goal:** from the checklist's "Choose a repository" you pick a repository; it becomes a project in the sidebar and the checklist moves on to setting it up.

**Screen `/projects/new`** (canvas: Add a repository):
- A solid top bar "Add a repository", then "Choose a repository" and its subtitle.
- **Account picker:** the user's installations (personal account and organisations), the first selected.
- **Search:** filters the list by name as you type, without new requests.
- **Rows:** name and a Private badge; language with its coloured dot and "Updated 2 hours ago"; **Add**, or **Added · Open** for a repository that is already a project; for one that isn't JavaScript or TypeScript and isn't added, "Doesn't look like JavaScript or TypeScript. hobai may not be able to set it up."
- **Adding:** the button is busy while `POST /projects` runs; the row becomes **Added · Open**, the project appears in the sidebar and the checklist moves to step 3. Open goes to `/projects/:id` (its page comes later).
- **Footer:** "Change which repositories hobai can access on GitHub", to the installation's settings (a personal account's and an organisation's URLs differ).
- **States:** loading (skeleton rows); no installations (install the GitHub App); an installation with no repositories (a note and the access link); no search match ("No repositories match …"); an API error (alert with Try again); GitHub sign-in expired (any 401 → sign in); adding fails, shown in the row: suspended installation (409) "The GitHub App is suspended on this account.", repository gone (404) "This repository is no longer available to hobai."
- **Installing on another account** from this page adds `state=add-repo` to the install link, so GitHub returns here with the same notices as on `/welcome`.
- **Touches:** the backdrop below the top bar; the heading and list rise in; rows light up on hover; no button glow (every row has an Add).

**Sidebar:** Projects lists your projects with a dot for the environment (green ready, amber needs attention, grey not set up), each linking to `/projects/:id` and marked when current; a **+** beside the heading goes to `/projects/new`; "No projects yet." when there are none.

**Server:** repositories gain `language`; the install callback returns to the page named by the install link's `state` (`add-repo` → `/projects/new`, anything else → `/welcome`).

**Underneath:** `features/github` `useRepositories(installationId)`; `features/projects` `useCreateProject()`, which refreshes the projects and that installation's repositories after adding; `lib/format.ts` for relative times (`Intl.RelativeTimeFormat`).

**Done when:**
1. With a new account: pick a repository, Add, and it shows **Added · Open**, appears in the sidebar, and `/welcome` shows step 3 current.
2. Installing on another account from this page comes back to `/projects/new` with the notice.
3. The page matches the canvas in light and dark and at phone width.
4. Tests cover the row in each state (add, adding, added, warning, error), the search, every page state, the sidebar's projects, the hooks, and the server's `language` and `state`.

**Batches:**
1. **Server:** `language`; the install link's `state` and the callback's return page; these requirements.
2. **Data:** `useRepositories`, `useCreateProject`, relative times; tests.
3. **Sidebar:** the projects list and its **+**.
4. **Screen:** `/projects/new` with its states.

## 14. Environment setup in the browser (requirements)

**Goal:** from the Welcome checklist's step 3 (or a project), you start setup, watch it work, answer its questions, and it ends saved; the checklist moves on to step 4.

**The setup page `/projects/:id/environment`** (canvas: Environment setup):
- **Top bar:** "<project> / Environment setup", a status badge (Queued, Setting up, Waiting for your answer, Saved as vN, Failed, Stopped), time and cost, **Stop setup** while it runs or waits.
- **Not started:** what setup does, and **Start setup**.
- **The conversation:** hobai's intro; a **timeline card** built from the events (projects found, installed with a command, checks with their badges, the agent's work grouped and expandable, info lines) with the beam while running and new lines rising in; a **question card** (question, why, options with the first marked Recommended, Something else when allowed, **Answer**; then your answer with your avatar; "Question N · I ask at most 5"); the **result**: saved (the environment's steps, checks and decisions, "Saved. <project> is ready.", **Describe your first task**, to New task with the project picked), failed (the reason, **Try again**), stopped (**Start again**).
- **Live:** reloading replays everything and continues; when setup ends the sidebar dot and the checklist update.

**Welcome step 3, in place:** **Start setup** starts it; the step shows a compact live card (beam, "Setting up <project>", the latest 3 lines, **Watch it live →**); while waiting, the question and **Answer** (opens the setup page); done ticks the step; failed or stopped shows the reason and **Try again**.

**Getting started card:** "Next: Set up <project> · in progress", or "· needs your answer".

**Sidebar:** the project being set up shows "Needs you" while its setup waits for an answer (only that project, to avoid asking for every project's setup); its dot turns green once saved.

**Underneath:** `features/setup/` (kept apart from `features/onboarding/`, the Welcome checklist): `api.ts`; `useOnboarding`, `useEnvironments`, and start / answer / stop mutations that update the cached setup; `useOnboardingEvents` (an `EventSource` on `/api/projects/:id/onboarding/events`, in order without repeats, closed on `done` or once ended, refreshing the setup, projects and environments); `buildTimeline(events)` (pure: the lines, the open question, the latest 3, whether it's done). Setup reports `setup_drafted` and phased `setup_completed` events for the timeline ([api.md](./api.md) §6).

**Not here:** the project page's Environment tab (versions, rollback, editing), re-running setup from "needs attention".

**Done when:**
1. With a new account: step 3 → Start setup → the live card → Watch it live → answer a question if one comes → saved; the step ticks and the sidebar dot turns green.
2. Reloading mid-setup shows everything so far and keeps going; the stream comes through the Next rewrite as it happens.
3. Stop works; a failed setup shows its reason with Try again.
4. Both boards match in light and dark and at phone width.
5. Tests cover the timeline for each event kind, the hooks (the events hook with a fake stream), each component state, the page states, and step 3.

**Batches:** 1. setup's structured events and the data layer; 2. the missing states on the canvas's Environment setup board; 3. the setup page; 4. Welcome step 3, the card and the sidebar.


## 15. Start a task (requirements)

**Goal:** you describe a change for a project that's set up, start it, and land on the task; the Welcome checklist's last step is done.

**The New task page `/new`** (canvas: New task (home)):
- "What should hobai do?", a large composer, and below it a row with the **project picker**, the **base branch**, the shortcut hint (⌘↵) and **Start**.
- **Project picker:** your projects with their default branch. Projects that aren't ready are listed but can't be picked, each with the reason: "Not set up" or "Needs attention" (each with a link to fix it), or "GitHub App suspended" / "GitHub App removed". **Add a repository** at the bottom goes to `/projects/new`. It starts on the project in `?project=`, else the last one you used, else the first ready one.
- **Base branch:** a dropdown showing the project's default branch. Opening it loads the repository's branches (`GET /projects/:id/branches`, once per project for 5 minutes): a search box, the list with the default first and marked, ✓ on the picked one, ↑↓ / ↵ / esc, "No branches match.", placeholders while loading, the reason with **Try again** when it can't load, and a note when only the first 1,000 are listed. Built on shadcn's Command (`cmdk`) in a Radix Popover.
- **Start:** enabled once there's text and a ready project; ⌘↵ (Ctrl↵) starts too. Busy while starting; then you go to `/tasks/:id`.
- A one-line hint on writing good tasks.
- **Recent tasks:** your latest 5 (title, project, status badge), each linking to its task; **View all** to the Inbox comes with the Inbox. Hidden when you have none.
- **States:** no projects (a note and **Add a repository**); no ready project (the picker shows why, with a link to finish setup); loading (skeletons); starting fails, shown above Start: not set up (409) with a link to its setup, needs attention (409) with a link to re-run setup, hobai busy (503) "hobai can't take new work right now. Try again in a moment.", anything else with **Try again**. The text you wrote is kept.
- **Touches:** the backdrop and rise-in like the other pages; **Start** glows.

**The task page `/tasks/:id`, first version:** the top bar (project › title, status badge), your message (avatar, time), and a card saying what the run is doing (Queued, Working, or how it ended) that refreshes every few seconds while it runs. The live run view replaces the card in step 6.

**Welcome step 4, in place:** a small task box for the project you just set up (its branch, **Start**, the hint); after starting, the step reads "“<title>” is running." with **Watch it work**, and the heading becomes "Your first task is running." The step is done once any task exists.

**Elsewhere:** the setup page's **Describe your first task** opens `/new?project=<id>`; the sidebar's **New task** goes to `/new` (marked when current) and **Recent** lists your last 10 tasks with a status icon, each linking to its task.

**Underneath:** `features/tasks/`: `api.ts`; `useTasks(projectId?)` (first page only, refetched every 3 s while any task is queued or working), `useTask(id)` (refetching every 3 s while the latest run is queued or running), `useStartTask(projectId)` (refreshes the task lists); `taskReadiness(project)` (ready, or the reason and its fix) and `startTaskError` (the messages above). `useNewTask` (the composer's state: text, project, branch, starting), shared by `/new` and Welcome step 4. `lib/routes.ts` gains `NEW_TASK`, `newTaskPath`, `environmentPath` and `taskPath`. Uses `POST /projects/:id/tasks`, `GET /tasks`, `GET /tasks/:id`; no server changes.

**Not here:** the live run view, outcomes and the PR card (steps 6–7), the Inbox (step 8).

**Done when:**
1. After setup: Describe your first task → `/new` with the project picked → Start → `/tasks/:id` shows Queued, then Working.
2. From Welcome step 4, a task starts in place and the step ticks; the heading changes.
3. A project that isn't ready can't be picked and says why; each start error shows its message and keeps the text.
4. The pages match the canvas in light and dark and at phone width.
5. Tests cover the picker's choices and reasons, the branch field, Start's enabling and shortcut, each error, the hooks, the task page's states, step 4, and the sidebar's Recent.

**Batches:** 1. these requirements and the missing states on the canvas; 2. the tasks data layer; 3. the New task page; 4. the task page's first version, Welcome step 4, the setup page's link and the sidebar.

## 16. Watch it work (requirements)

**Goal:** on a task's page you watch its run as it happens, the same way you watch setup: what stage it's in, what the agent is reading, editing and running, what it's thinking, which files changed and every command's output. Reloading loses nothing. (The finished run's full outcome, the PR card, Cancel and every outcome state are step 7.)

**The task page `/tasks/:id`** (canvas: Task: run in progress):
- **Top bar:** project › title (it updates when the run writes the task's short title, `task_titled`), the status badge, the base branch, duration and cost so far.
- **Conversation:** your message, then the **run card**:
  - header: hobai, Run N, status, steps and cost (from `agent_step` while live; from the run once ended);
  - **stages** Prepare · Set up · Working · Checks · Pull request, each pending / running (spinner) / done (✓) / failed, with a one-line summary and its duration: Prepare "Sandbox ready, cloned `main`"; Set up "Environment vN · before: 5 checks passing" (from `setup_completed`); Working "N steps"; Checks "run again and compared" until done, then "5 passing" or "1 broken by this change"; Pull request "on a new branch" until `pr_opened`;
  - **Working** shows the agent's activity, built from `tool_start` / `tool_end`: consecutive reads, searches and listings fold into "Explored the code · read 6 files, searched 2 times" (expandable); each edit or written file is a row with its path; each command a row with its result (✓ exit 0, ✗ exit N); `run_checks` a row with its results; the one in progress has a spinner. The agent's latest reasoning streams underneath in a quieter style (`text_delta`, live only);
  - the beam while the run is queued or running; new rows rise in.
- **Side panel**, tabs:
  - **Changes:** while running, the files the agent has edited or written, with +/− counted from its edits (the lines it replaced and wrote), and "The full diff appears when the run finishes."; once the run has ended, the real diff (`GET /runs/:id/diff`): files with +/−, a file's lines when picked.
  - **Terminal:** every command the agent ran, newest last, with its output and exit code; the one running shows "running…". Output is what the run reports, at most 2,000 characters a command, marked when cut short (full logs come later).
  - **Checks:** each check with **Before** (`setup_completed`) and **After** (`checks_completed`, new): passing · fixed · broken by this change · still failing · pending until Checks has run.
  - Picking an edit or a command in the run card opens it in the panel.
- **States:** queued (stages pending, "Waiting for a sandbox"), running, ended (stages final; the summary and the PR link as today, until step 7), the stream reconnecting, the task not found, couldn't load.
- **At phone width** the panel stacks below the conversation.

**Server:** the runner emits **`checks_completed`** when Checks ends: each check's name, folder, command, status and comparison with before (`passing`, `failing`, `fixed`, `regressed`, `still-failing`). Stored like the other events.

**Underneath:**
- `features/runs/`: `useRunEvents(runId)`: an `EventSource` on `/api/runs/:id/events`, stored then live, in order without repeats, closed on `done` or once the run has ended; `text_delta` and `agent_step` kept apart (live only). Refreshes the task when the run's stage, title or outcome changes.
- `buildRunView(events)`: pure. The stages with their state, summary and duration; the activity groups; the latest reasoning; steps and cost; the files touched; the commands with their output; the checks before and after; the PR. Tested with lists of events, no browser or server.
- `useRunDiff(runId)` once the run has ended.
- The polling task page from step 5 stops polling: the stream drives it.

**Not here:** Cancel, the finished run's outcome card (summary, checks table, PR card, failed / cancelled / no changes / incomplete), follow-ups (step 7); full command logs; a live diff while running.

**Done when:**
1. Starting a task and opening it shows each stage in turn, the agent's activity and reasoning as they happen, then the end.
2. Reloading mid-run shows everything so far and keeps going; the stream comes through the Next rewrite as it happens.
3. Changes, Terminal and Checks show what the run did; picking a row opens it.
4. The page matches the canvas in light and dark and at phone width.
5. Tests cover `buildRunView` for each event kind (grouping, stages, durations, checks), the events hook with a fake stream, each component state, and the page.

**Batches:** 1. these requirements and the canvas; 2. `checks_completed` in the runner and worker; 3. the run's events in the browser (`useRunEvents`, `buildRunView`); 4. the run card (stages, activity, reasoning); 5. the side panel (Changes, Terminal, Checks) and linking rows to it.

## 17. Get the PR (requirements)

**Goal:** when a run ends, hobai replies under its run card, the way a message follows another in a conversation, with the result: the summary, the checks before and after, and the pull request, or why there isn't one. You can cancel a run while it's queued or working. Every way a task can end has its own state. (Follow-ups, and the composer with them, come in Phase 5.)

**The task page `/tasks/:id`** (canvas: Task: PR opened, its `outcome` switch; Task: run in progress for Cancel):
- **Cancel** in the top bar while the run is queued or working (`POST /runs/:id/cancel`). A queued run ends at once (`cancelled`); a working one answers `stopping`: the button reads "Stopping…" and is disabled until the run ends. "This run has already ended" (409) just refreshes the task; anything else shows "Couldn't cancel. Try again." under the top bar.
- **The run card, once the run has ended** (canvas switch `watched`):
  - header: hobai, Run N, the run's status (Succeeded, Incomplete, No changes needed, Failed, Cancelled), duration · steps · cost, and **Show steps** / **Hide steps**;
  - the stages as they were live, each final: ✓ done, ✗ failed, ■ stopped (a limit, or cancelled), ○ not run; Working keeps its activity, whose rows still open in the panel;
  - **If you watched it end**, nothing folds or moves: the stages just finish. **If you open the task after it ended**, the stages start folded behind **Show steps**, so the result is in view; a failed run starts unfolded.
- **The result**, a new message from hobai under the run card (avatar, time), rising in when the run ends; the page scrolls to it only if you were at the bottom. It holds:
  - the **summary** (`run.summary`), as the agent wrote it;
  - the **checks table**: Check (name, folder) · Before · After, After as passing · fixed · broken by this change · still failing; runs without per-check results say "All checks passed" or "Some checks failed"; none when the repository has no checks;
  - the **PR card**: the task's title and #number, a line saying where it stands, **Open on GitHub**;
  - or, instead, the notice: the limit it stopped at, the failure, or the cancellation.
- **Every end state:**

  | State | Badge (top bar) | In the result |
  |---|---|---|
  | PR ready | PR #N open | summary, checks, PR "Ready for review · verified commit `abc1234` by hobai[bot] · into `main`" |
  | Draft PR | Draft PR #N | as ready; PR "Draft: checks still failing" or "Draft: stopped before finishing" |
  | Merged | PR #N merged | as ready; PR "Merged into `main`" |
  | Closed | PR #N closed | as ready; PR "Closed without merging" |
  | No changes | No changes | summary, "No branch or pull request was created." |
  | Incomplete | Draft PR #N, or No changes | "Stopped at the step limit." (time, cost) above the summary; a draft PR when there were changes |
  | Failed | Failed | where it failed and why, from the error code (below); "Nothing was pushed." |
  | Cancelled | Cancelled | "You cancelled this run after 3m 02s." (or "before it started"); "The sandbox was removed and nothing was pushed." |

  Merged and closed come from GitHub (the webhook sets the task's status); the page picks them up when you come back to it.
- **Failure messages**, by `run.error.code`, each with the run's message under it: `prepare_failed` / `sandbox_failed` / `checkout_failed` "Couldn't prepare the sandbox"; `sandbox_busy` "No sandbox was free"; `setup_failed` "Failed during setup" with **Re-run environment setup**; `no_environment` "This project isn't set up" with **Set it up**; `agent_failed` "Failed while working"; `verify_failed` "Failed while running the checks"; `deliver_failed` "Couldn't open the pull request" (the diff stays in Changes); `github_access` "Couldn't reach the repository on GitHub" with **Check the project** (the project page shows whether the App was suspended or removed); `worker_lost` / `lost_in_queue` / `worker_error` "hobai stopped unexpectedly"; anything else "The run failed".
- **Activity:** consecutive edits and writes to the same file are one row: the path, "+8 −5 · 2 edits", opening that file in Changes. Live and finished alike.

**Server:** none for the page. **Worker:** the PR description links to the task page (`FRONTEND_URL/tasks/:id`, from Phase 3's note), left out when `FRONTEND_URL` isn't set.

**Underneath:**
- `features/runs/`: `useCancelRun(runId)` (refreshes the task; keeps "stopping" until the run ends). `buildRunView` merges consecutive edits to one file.
- `runOutcome({ task, run, title, checksDone })` (`features/runs/outcome.ts`): pure. The state from the table, the badge, the card's notice (limit, failure, cancelled) with its link, the PR line. Tested for each state and error code.
- The run card's ended and folded states and the result message as components. `TaskScreen` remembers whether it saw the run live (`watched`) to pick folded or not.

**Not here:** follow-ups, replies and the composer, Run again / retries (Phase 5); full command and install logs; who merged the PR; the Inbox (step 8).

**Done when:**
1. A run that opens a PR ends with a result message under the run card (summary, checks table, PR card), and the run card doesn't fold while you watch; Open on GitHub goes to the PR. Merging or closing it on GitHub shows on the page.
2. Cancel stops a queued run at once and a working one within seconds; the card says it was cancelled.
3. Each end state in the table looks as described, including each failure message.
4. Repeated edits to one file show as one row.
5. The page matches the canvas in light and dark and at phone width.
6. Tests cover `runOutcome` for every state and code, the merged edit rows, `useCancelRun`, the ended and folded run card, the result message and the page; the worker's PR description with and without `FRONTEND_URL`.

**Batches:** 1. these requirements and the canvas; 2. Cancel (`useCancelRun`, the top bar button, stopping); 3. merged edit rows; 4. `runOutcome`; 5a. the checks table as its own component; 5b. the result message (summary, checks table, PR card, notices); 5c. the run card's ended and folded states, and scrolling to the result; 6. the task link in the PR description. (A composer saying follow-ups aren't available was dropped: it comes with follow-ups.)

## 18. Find your work (requirements)

**Goal:** you can find every task you started, across projects or within one, and see at a glance what needs you, what's running and what has a PR. A project's page shows its tasks, its environment with the versions you can go back to, and its settings.

**The Inbox `/inbox`** (canvas: Inbox, its `state` switch):
- **Top bar:** "Inbox" and **New task**.
- **Filters**, each with a count: All · Needs you · Running · PR open · Done, kept in the URL (`?filter=`). Needs you: setups waiting for your answer. Running: queued and working. PR open: open and draft PRs. Done: merged, closed, no changes, failed, cancelled.
- **Rows**, newest first, grouped by day: Today · Yesterday · Earlier this week · Earlier. A row: the status icon, the title, a detail line, the project, the status badge, duration · cost, when it was last updated; the whole row opens the task.
- **The detail line:**

  | State | Detail |
  |---|---|
  | Queued | "Waiting for a sandbox" |
  | Working | the stage: "Preparing the sandbox", "Setting up", "Working", "Running the checks", "Opening the pull request" |
  | PR open | "Checks passing · 4 files changed" or "Checks failing · …"; "No checks · …" when the repository has none |
  | Draft PR | "Draft: checks still failing" or "Draft: stopped before finishing" |
  | Merged / Closed | "Merged into `main`" / "Closed without merging" |
  | No changes | the summary's first line |
  | Failed | where it failed, as on the task page (`runOutcome`), e.g. "Failed during setup" |
  | Cancelled | "You cancelled this task" |

- **A setup waiting for your answer** is a row at the top: "Set up <repo>", "hobai has a question", the badge Needs your answer, its duration and cost; it opens the project's Environment tab. (Tasks don't wait on you until follow-ups in Phase 5.)
- **Load more** at the bottom, 50 at a time. The list refreshes every 3 s while anything is queued, working or waiting.
- **States:** loading (placeholder rows); no tasks at all sends you to `/welcome`; a filter with nothing in it, "No tasks match this filter."; couldn't load, **Try again**.
- **Elsewhere:** the sidebar's Inbox count is the tasks queued or working plus the setups waiting for you. The New task page's Recent tasks gets **View all**. The end of sign-in goes to `/inbox`, which sends you to `/welcome` until you have a task; `/` stays the landing page (§8).

**The project page `/projects/:id`** (canvas: Project, its `tab`, `tasks`, `health`, `lastSetup`, `restore` and `remove` switches):
- **Top bar:** the repository's name, `owner/name` linking to GitHub, **New task** (`/new?project=`). **Tabs:** Tasks · Environment · Settings, each its own route (`/projects/:id`, `/environment`, `/settings`); Environment shows a dot when it needs attention.
- **Needs attention**, on every tab when the environment's health says so: the reasons and **Re-run setup**.
- **Tasks:** Task · Status · Pull request (#N, opening it on GitHub) · Runs · Duration · Cost · Updated; a row opens the task; Load more and refreshing as in the Inbox. States: loading, "No tasks in this project yet" with **New task**, couldn't load with **Try again**.
- **Environment:**
  - while a setup is queued, running or waiting, or before any environment is saved: the setup conversation, as today;
  - otherwise the active environment: its version and health, when it was saved, the setup steps (name, folder, command) and the checks (name, folder, command), and **Re-run setup**;
  - if the latest setup failed or was stopped, a note above it: "The last setup didn't finish: <why>. New tasks still use vN." with **View it** (the conversation);
  - **Versions:** each saved version, newest first: vN, active or replaced, how it was made and when. A replaced one has **Restore**, which asks first ("Make v1 active again? New tasks will use its steps and checks. v2 is kept.") and then makes it the active version, with the health it had. Refused while a setup is in progress ("Finish or stop the setup first."); anything else shows "Couldn't restore v1. Try again."
- **Settings:** Repository (`owner/name`); Default branch ("new tasks start from it; follows GitHub"); GitHub access (through the App installed on <account>, **Manage on GitHub**); **Remove project**, which asks first in a dialog saying what's deleted and that GitHub isn't touched. While a run is queued or running it can't (409): "A task is still running in this project. Wait for it to finish, or cancel it, then remove the project." Once removed you go to `/inbox`.
- **The sidebar:** a project opens its Tasks tab (today it opens setup).

**Server:**
- `GET /tasks` gains `filter` (`needs_you` is setups, so the task filters are `running`, `pr`, `done`): the label's rules move into the query, so filters and pages stay right past 50 tasks. Each page carries `counts` per filter. The list's `latestRun` gains `checksPassed` and `filesChanged`, and `summary`'s first line for No changes.
- `POST /projects/:id/environments/:version/restore` → 200 with the restored version: 404 for an unknown version, 409 `SETUP_IN_PROGRESS` while a setup is queued, running or waiting. Reactivating and superseding the active one is one transaction ([database.md](./database.md)).
- Setups waiting for you: `GET /projects` gains each project's latest setup status (`setup: { id, status } | null`), so the sidebar and Inbox know without one request per project.

**Underneath:**
- `features/tasks/`: `useTaskPages({ projectId, filter })` (pages with `useInfiniteQuery`, refreshing while active) for the Inbox and the project's Tasks tab, `useTaskCounts()`; `taskDetail(task)` and `groupByDay(tasks, now)`, pure and tested per state.
- `features/projects/`: `useRestoreEnvironment(projectId)`, `useRemoveProject()`; the setups waiting for you, from the projects list.
- Components: `FilterPills`, `TaskRow`, `VersionRow` (molecules); `InboxList`, `ProjectTaskTable`, `EnvironmentSummary`, `RemoveProjectDialog` (organisms); `ProjectTabs` (template).

**Not here:** editing the environment by hand; searching tasks; full command logs; the end-to-end test (step 9).

**Done when:**
1. The Inbox lists every task by day; each filter and count is right, also past 50 tasks; running ones update in place.
2. A setup waiting for an answer shows under Needs you, in the sidebar count, and opens the setup.
3. The project page shows its tasks; its Environment tab shows the setup while one runs and the active environment otherwise; Restore makes an older version active.
4. Remove project asks first, is refused while a task runs, and lands on the Inbox.
5. Signing in takes someone with tasks to the Inbox, and someone without to `/welcome`.
6. The pages match the canvas in light and dark and at phone width.
7. Tests cover the filters, counts and restore on the server; `taskDetail`, `groupByDay`, the hooks, each page state, Restore and Remove project.

**Batches:** 1. these requirements and the canvas; 2. the task list's filter, counts and new fields; 3. restoring an environment version, and each project's latest setup in the list; 4. the tasks data layer (`useTaskInbox`, `taskDetail`, `groupByDay`); 5. the Inbox page, the sidebar count, the home redirect and View all; 6. the project page's tabs and Tasks tab, the sidebar link; 7. the Environment tab (summary, versions, Restore); 8. Settings and Remove project.

## 19. End to end (requirements)

**Goal:** one Playwright test walks the whole journey in a real browser against the real web app, server, worker, Postgres, Redis and a Docker sandbox, and fails if any piece stops fitting the next. It costs nothing to run: no model, no Daytona, GitHub faked. It runs **on demand** (`pnpm e2e`), not in CI, so pull requests never wait for it; run it before merging a change that crosses apps.

**The journey** (`apps/e2e/tests/journey.spec.ts`, one page through every step, in order):
1. **Sign in:** the landing page, **Sign in with GitHub**, **Continue with GitHub**; you arrive on `/welcome`.
2. **Connect GitHub:** **Install on GitHub**; back on `/welcome`, "GitHub App installed."
3. **Add a repository:** **Add Hello-World** in the checklist's picker; the project appears in the sidebar.
4. **Set up the environment:** **Start setup**; the setup's question shows in the checklist, **Answer** opens the Environment tab, you pick an option, and it's "Saved as v1".
5. **Start a task:** **New task**, describe it, **Start**; you land on the task.
6. **Watch it work:** the Working stage with "Wrote README +2", and the change in the Changes tab.
7. **Get the PR:** **Open PR #7 on GitHub** links to `github.com/octocat/Hello-World/pull/7`, with the summary.
8. **Find your work:** the Inbox's PR open filter shows the task, "Checks passing · 1 file changed"; the project's Tasks tab lists it with #7.
9. **Merged:** a signed `pull_request` webhook saying it was merged reaches the server; the Inbox's Done filter shows "Merged into master".

Each step checks what you see on the screen, not rows in the database.

**What's faked, and where:**
- **GitHub's pages:** Playwright catches the browser's trips to GitHub's sign-in and App install pages and sends it straight back to our callbacks, as if you had approved there. Better Auth and our install callback still do their real work.
- **GitHub's API, for the server:** `apps/server/src/e2e.ts` replaces `fetch` with `e2eGithubFetch` (`@hobai/github/testing`) and then starts the server as usual. It answers the sign-in token exchange, the user and their emails, the App, installations (none until the test has installed the App: a flag file the test writes), the repository and its branches; anything else on GitHub gets a 404 and shows in the log; other hosts go to the real network. The App's private key is a throwaway one made for each run.
- **GitHub's API, for the worker:** the worker's `fakeGithubApp` with an empty token (a public clone needs none), and a delivery that builds the same tree hash git does, so the worker's check that GitHub stored exactly its commit still runs.
- **The model:** `scriptedModel` (`@hobai/agent/testing`), scripted in `apps/e2e/src/journey.ts`: the setup asks with `ask_user`, then `finish_setup` with one check; the task reads the README, rewrites it, then `finish_task`; a scripted title. The worker starts through `startWorker(config, log, overrides)` from `@hobai/worker`, the same function `pnpm dev:worker` uses, with the scripted models and the fake GitHub as overrides.
- **Real:** the web app (a production build), the API, the worker, the queue, Postgres, Redis, and a `DockerSandbox` cloning the public `octocat/Hello-World`, as the worker's end-to-end test does.
- **Kept apart from dev:** its own database (`hobai_e2e`, recreated and migrated each run), Redis database 1 (emptied each run), its own ports (web 3100, API 3101, worker health 3102), and its own Next build folder (`NEXT_DIST_DIR=.next-e2e`), so a running `next dev` is left alone. No secrets needed.
- Production code paths don't change: the fakes enter only through the test entry points.

**Running it:**

```bash
pnpm sandbox:build-image                                     # once, as for dev
pnpm --filter @hobai/e2e exec playwright install chromium   # once
pnpm e2e
```

Needs Docker and the dev Postgres and Redis running (`pnpm setup` starts them) and network access to clone from github.com. Playwright resets the database and Redis, starts the API, the worker and the web app (`next build` and `next start`) one after another, waits until each answers, then runs the steps: about 45 s plus the build. Chromium only, desktop width. To watch it: `pnpm e2e --headed` (a browser window; add `E2E_SLOW=500` to wait 500 ms before each action), `pnpm e2e --ui` (Playwright's UI: run it, then click any step to see the page at that moment) or `pnpm e2e --debug` (one action at a time). On failure: a screenshot, a trace and a video in `apps/e2e/test-results/`, the report with `pnpm e2e:report`, and each server's output in `apps/e2e/.state/logs/`.

**Not here:** running it in CI; real GitHub or a real model; other browsers; screenshot comparison against the canvas (still checked by hand); every failure outcome (unit and integration tests cover those); Daytona.

**Done when:**
1. `pnpm e2e` passes from a clean checkout with Docker, Postgres and Redis running, without secrets, in a few minutes.
2. Breaking any step of the journey (a wrong endpoint, a missing event, a broken redirect) makes it fail at that step, with the screenshot and logs to see why.
3. Dev data and dev servers are untouched by a run.
