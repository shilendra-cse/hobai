# GitHub

> Status: **Built** · Last updated: 2026-10-25 · Code: `packages/github` · Related: [architecture.md](./architecture.md) (D3), [development-plan.md](./development-plan.md) (Phase 3)

hobai reaches GitHub through **one GitHub App**: users sign in with it, install it on the repositories hobai may work on, and the worker gets short-lived tokens from it to clone, commit and open pull requests as `<app-slug>[bot]`. No user's own GitHub token is used to touch repositories.

## 1. How access works

```
App ID + private key (ours, secret)
   │  sign a JWT ("I am App 123", valid 10 min)
   ▼
GitHub: installation 42 = "acme allowed the App into acme/api and acme/web"
   │  JWT + "token for installation 42, repo acme/api, contents: read"
   ▼
installation token ghs_…  (one repository, only those permissions, expires within 1 hour)
   │
   ▼
git clone, REST API calls (commits, pull requests)
```

- **App** (registered once): its ID and private key prove "this is hobai". The private key never leaves the server and the worker.
- **Installation**: an account or organization allowing the App into some or all of its repositories. Users choose; "All repositories" is one click.
- **Installation token**: what actually opens a repository. Minted per use, never stored.

## 2. Tokens

| Use | Permissions | Minted by | Where the token goes |
|---|---|---|---|
| Clone | `contents: read` | worker | only the `git clone` command; the remote is the plain URL afterwards |
| Commit and open the PR | `contents: write`, `pull_requests: write` | worker, at delivery | the worker's API client only; never the sandbox (§8) |
| Repo picker | the user's sign-in token (installations they can access) | server | server only |

Every token is scoped to **one repository** and expires within an hour. `repoToken` reuses a token until it has less than 5 minutes left. The agent has a shell in the sandbox, so a token is never left where it could read it (`.git/config`, the remote URL, the environment).

## 3. `@hobai/github`

| Export | What it does |
|---|---|
| `createGithubApp({ appId, privateKey })` | The App client; one per process |
| `repoToken(installationId, repoId, permissions)` | A token for one repository with only those permissions, at least 5 minutes left |
| `repoClient(installationId, repoId, permissions)` | An Octokit client authenticated with such a token |
| `installationForRepo(owner, repo)` | The installation covering a repository, or `null` |
| `findInstalledRepo(owner, repo)` | That installation plus the repository's id, default branch and visibility, or `null` |
| `botIdentity()` | `{ name: "<slug>[bot]", email: "<id>+<slug>[bot]@users.noreply.github.com" }`: the commit author GitHub shows as the bot |
| `commitToBranch(client, commit)` | One commit on a new branch through the API: blobs → tree on the parent's → commit → branch, each blob and the tree checked against git's hashes |
| `CommitMismatchError` | What `commitToBranch` throws when GitHub's blob or tree hash differs from the expected one |
| `draftPullRequestsUnavailable(error)` | Whether GitHub refused a draft pull request (GitHub Free, private repositories) |
| `verifyWebhookSignature(secret, rawBody, signature)` | Checks `X-Hub-Signature-256` over the raw request body |
| `parsePrivateKey(value)` | The PEM key as downloaded, or on one line with `\n` |
| `listUserInstallations(userToken)` · `listInstallationRepos(userToken, installationId)` | Through the user's token: the installations they can access, and an installation's repositories (`null` when they can't access it) |
| `listRepoBranches(userToken, owner, repo, { limit? })` | The repository's branch names (`{ names, truncated }`); `null` when the user can't see it |

Tests answer with GitHub's response shapes and sign real JWTs; nothing calls GitHub. `@hobai/github/testing` has the fake (`fakeGithub`, `fakeGithubClient`) for other packages' tests, and the fake GitHub for the end-to-end test: `E2E_GITHUB` (one user, one installation, the public `octocat/Hello-World`) and `e2eGithubFetch`, a `fetch` that answers `github.com` and `api.github.com` itself. `apps/server/src/e2e.ts` installs it before starting the API; it requires `E2E_GITHUB_INSTALLED_FLAG` (a file whose existence means the App is installed) and generates a throwaway App private key.

## 4. Registering the dev App

On GitHub: **Settings → Developer settings → GitHub Apps → New GitHub App** (under your account, or an organization's settings for an org-owned App).

| Field | Value |
|---|---|
| GitHub App name | unique on GitHub, e.g. `hobai-dev-<you>`; it becomes the bot's name (`<name>[bot]`) |
| Homepage URL | `http://localhost:3000` |
| Callback URL | `http://localhost:3000/api/auth/callback/github` (sign-in, through the web app's `/api` rewrite; must match `BETTER_AUTH_URL`) |
| Expire user authorization tokens | checked |
| Request user authorization (OAuth) during installation | unchecked |
| Setup URL | `http://localhost:3000/api/github/installations/callback` (through the web app's `/api` rewrite) |
| Redirect on update | checked |
| Webhook → Active | checked |
| Webhook URL | a smee.io channel (create one at https://smee.io/new); `pnpm dev:webhooks` forwards it to the server |
| Webhook secret | a long random string (`openssl rand -hex 32`) |
| Repository permissions | **Contents: Read and write**, **Pull requests: Read and write**, Metadata: Read-only (required) |
| Account permissions | **Email addresses: Read-only** (sign-in needs the user's email) |
| Subscribe to events | **Pull request** (installation events are always sent) |
| Where can this GitHub App be installed? | **Only on this account** for development, or **Any account** to install it on an organization |

After **Create GitHub App**:
1. Note the **App ID** and **Client ID** at the top of the App's page.
2. **Generate a new client secret** and copy it.
3. **Generate a private key**: a `.pem` file downloads.
4. **Install App** (left menu) on a test repository; a private one proves private access.

## 5. Settings

| Setting | Server | Worker |
|---|---|---|
| `GITHUB_APP_ID` | ✓ | ✓ (clone and delivery; required) |
| `GITHUB_APP_PRIVATE_KEY` (the `.pem` contents; one line with `\n` is fine) | ✓ | ✓ (clone and delivery; required) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (the App's, for sign-in) | ✓ | |
| `GITHUB_WEBHOOK_SECRET` (the same value as in the App's webhook settings) | ✓ | |
| `GITHUB_WEBHOOK_PROXY_URL` (development: the smee channel, for `pnpm dev:webhooks`) | ✓ | |
| `FRONTEND_URL` (optional: links the task in the PR description) | | ✓ |

Keep the private key and secrets in the git-ignored `.env` files only.

## 6. The server's GitHub flows

```
Sign in:   web "Continue with Github" → Better Auth (the App's client id) → session + the user's GitHub token

Install:   installUrl[?state=add-repo] → GitHub → Setup URL: GET /api/github/installations/callback?installation_id=…&state=…
             → signed in? the user's token lists their installations → is this one of them? → github_installations
             → back to the page it started from: state=add-repo → /projects/new, anything else → /welcome
               (?github=installed | not-found | requested | cancelled; signed out → /signin?next=that page)

Webhooks:  GitHub → (smee in development) → POST /api/github/webhooks
             → signature over the raw body ✓ → delivery seen before? (webhook_deliveries) → skip
             → installation created / deleted / suspend / unsuspend → github_installations
               installation_repositories → logged (repositories are listed live)
               pull_request → the task with that PR (repository id + number): open → pr_open,
                              merged → merged, closed → closed; other PRs ignored

Picker:    GET /api/github/installations                     → the user's installations + installUrl
           GET /api/github/installations/:id/repositories    → repositories the user can access
           GET /api/projects/:id/branches                    → the project repository's branches (listRepoBranches)
```

- **Sign-in is GitHub only**, through the App's OAuth. The user's GitHub token is read through Better Auth's `getAccessToken`, which refreshes it when it has expired (the App's user tokens last 8 hours); without one, the user signs in again (`GITHUB_SIGN_IN_REQUIRED`).
- **The install callback checks ownership**: the installation id arrives in the URL, so it's recorded only if the user's own token can see it.
- **Webhooks**: an installation by a GitHub user who hasn't signed in yet is skipped and recorded later by the callback. A delivery that fails is forgotten again and answered with 500, so GitHub's redelivery is processed. Uninstalling marks `uninstalled_at` instead of deleting, since projects cascade from the installation. A pull request's task status comes from the PR's state rather than the event's action, so repeated deliveries and actions like `synchronize` change nothing; deliveries arriving out of order (rare) can leave an older state.
- **Repositories** are always listed live from GitHub through the user's token, so they reflect what the user can access right now.
- **Code**: `apps/server/src/resources/github/` (routes, webhook handler and events, install callback, controllers); the raw body for signature checks is kept by `express.json({ verify: keepRawBody })`.

Development: run `pnpm dev:server` and `pnpm dev:webhooks` (forwards `GITHUB_WEBHOOK_PROXY_URL` to the local endpoint).

## 7. The worker's clone

```
run-task / onboard-project
  → the project's installation (github_installations) → uninstalled or suspended? → fail: github_access
  → repoToken(installation, repository, { contents: "read" })
  → git clone with GIT_CONFIG_COUNT / GIT_CONFIG_KEY_0=http.extraHeader / GIT_CONFIG_VALUE_0=AUTHORIZATION: basic …
    in that one command's environment
```

- Git reads `GIT_CONFIG_*` as configuration for that command only, so the token never reaches `.git/config`, the remote URL, the command line or the sandbox's environment; the agent's shell can't find it.
- A token that GitHub refuses fails the run at checkout (`checkout_failed`); a missing, uninstalled or suspended installation fails it before the sandbox is created (`github_access`). Onboarding reports the same through its `done` event.
- Run and setup events and logs go through `redactGithubTokens`, which keeps a token's prefix (`ghs_***`) and drops the rest, in case git or the agent ever prints one (e.g. from a file in the repository). The agent's streamed text (`text_delta`) isn't checked: it's never stored, only shown live to the run's owner, and a token would arrive split across many deltas ([worker-capacity.md](./worker-capacity.md) §2.2).
- **Code**: `apps/worker/src/github/repo-token.ts`, `packages/runner/src/lib/git-auth.ts`.

## 8. Delivery

After the agent's last write, the sandbox is untrusted: anything the agent left running could read a token passed to a command there. So the commit is made through GitHub's API by the worker, from the changes read out of the sandbox:

```
sandbox (runner, deliver stage)                 worker (deliverToGithub)
  git write-tree (snapshot, before verify)
  git diff-tree baseline..snapshot  ──► change set: parent (the cloned commit), expected tree,
                                        files (path, mode, blob hash), deletions
                                          │  installation still installed? → contents + pull_requests: write
                                          ▼
                     for each file: read it from the sandbox (base64 chunks) → POST git/blobs   hash = git's?
                     GET git/commits/<parent> → POST git/trees (base_tree)                       hash = expected?
                     POST git/commits (no author: the App, signed, "Verified") → POST git/refs
                     → POST pulls (draft when checks failed or the run is incomplete)
```

- **What's in the commit:** only the agent's changes since the baseline, on top of the cloned commit. The baseline commit and files that only setup or the checks wrote stay out; a file both setup and the agent changed goes in with its final content.
- **Branch:** `hobai/<slug of the task title>-<first 4 of the task id>`, never the default branch. The title is the short one the model writes at the start of the task's first run ([agent.md](./agent.md) §10), else the prompt's first line; delivery waits for it. **Title:** the agent's `finish_task` title, else the task title; it's the commit subject and the PR title. **Body:** the agent's summary, a checks table, the changed files, notes for an incomplete run, and a link to the task in hobai (`FRONTEND_URL/tasks/:id`, left out when `FRONTEND_URL` isn't set).
- **Draft PRs** aren't available in private repositories on GitHub Free; GitHub refuses them, and the PR is opened ready with a "Not ready to merge" note.
- **Limits:** 1,000 files and 50 MB per delivery; submodule changes and non-UTF-8 file names can't be delivered. Any failure fails the run with `deliver_failed`; its diff is still saved.
- **Recorded:** the task's `branch_name` once the branch exists, then `pr_number`, `pr_url` and `pr_open`; the run's `commit_sha`; events `branch_created`, `git_push`, `pr_opened`.
- **Code:** `packages/runner/src/stages/deliver/`, `packages/github/src/commit-to-branch.ts`, `apps/worker/src/delivery/`.
