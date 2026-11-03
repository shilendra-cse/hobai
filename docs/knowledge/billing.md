# Plans & Billing

> Status: **Accepted** · Last updated: 2026-10-30 · Related: [requirements.md](./requirements.md), [development-plan.md](./development-plan.md), [database.md](./database.md) (`plans`, `subscriptions`), [api.md](./api.md), [ui.md](./ui.md) (pricing page, usage)

## 1. MVP: free tier only

| | Free |
|---|---|
| Runs | 10 per cycle (a month from the day you signed up) |
| Model | GPT-6 Luna (platform-controlled) |
| Concurrent runs | 1 |
| Price | ₹0 |

No payment setup in the MVP. Limits are enforced when a task is created and rejected with a clear message; the web app shows the runs used this cycle. Built in Phase 5 ([development-plan.md](./development-plan.md)), before the deploy.

## 2. Plans, subscriptions and limits

Limits live in data, not code: every user is on a **plan**, and the plan says what's allowed. The free tier, the author's own access and later Pro tiers are all rows, so changing one never needs a deploy, and the admin panel (§6) edits the same rows.

- **Plan** (`plans`): a slug, a name, and its limits: runs per cycle (`null` = no limit) and concurrent runs. Seeded with `free` (10 runs, 1 at a time) and `unlimited` (no run limit, 3 at a time; internal, for the author). Later plans add a price and included credits (§4).
- **Subscription** (`subscriptions`): which plan a user is on, and their current cycle (`period_start`, `period_end`). Every user is on `free` from signup: the subscription is created the first time it's needed (`ensureSubscription`), its cycles counted from the user's `created_at`, so existing users need no backfill. `source` says how they got it: `signup`, `admin`, later `payment`.
- **Cycle:** a month long, from the user's own start date: signed up on the 25th, it resets on the 25th (on a shorter month, its last day). When a cycle has ended, the next request that needs it moves it to the cycle containing now (months without a request are skipped). When paid plans come, the payment provider's billing period becomes the same `period_start` / `period_end`.
- **Changing plan:** `pnpm admin:set-plan <email> <plan>` (by email, since accounts don't store the GitHub login; the author puts themself on `unlimited`); later the admin panel's button does the same. The cycle stays as it is.

### What counts as a run
Every task run started in the current cycle, except those that failed through hobai's fault: `queue_unavailable`, `worker_error`, `worker_lost`, `stalled`, `checkout_failed`, `sandbox_failed` and `sandbox_busy` (no sandbox was free, even after waiting). Cancelled runs and runs where the agent failed count; they still cost. **Setups never count.** Usage isn't stored as a counter; it's counted from `runs`, so it can't drift.

### The limits
Checked when a task starts (`POST /projects/:id/tasks`), together with creating the task, in one transaction locked per user, so two quick clicks can't both get through.

| Limit | From | Over the limit | Message |
|---|---|---|---|
| Tasks running at once | the plan (`free`: 1) | `409 RUN_IN_PROGRESS` | "You already have a task running. Wait for it to finish, or cancel it." |
| Runs per cycle | the plan (`free`: 10) | `429 RUN_LIMIT_REACHED` | "You've used all 10 runs this cycle. They reset on 25 Nov." |
| Daily spend, all users together | `DAILY_SPEND_CAP_USD` (default $5): model cost of today's runs and setups (UTC day) | `503 DAILY_CAPACITY_REACHED` | "hobai has reached today's capacity. Try again tomorrow." |

The daily cap is also checked when a setup starts, since setups spend too. It protects hobai's own costs, so it applies to every plan, `unlimited` included. It counts model cost only: sandbox minutes aren't recorded per run yet (§4 needs them later).

### Usage in the app
`GET /me/usage` returns the plan, runs used and the limit, the concurrency limit, and when the cycle resets. The web app shows it in **Usage & limits** ([ui.md](./ui.md)).

## 3. After launch: Pro plans

- **Subscription:** a fixed monthly price, starting at **₹599** (incl. GST), with higher tiers above it. It pays for infra and includes credits.
- **Top-ups:** more credits when the included ones run out. Priced at cost or slightly above (payment fees, GST, exchange rate); they pay for usage, not infra.
- **Model choice:** per run, any model in the catalog. Plans differ by price and included credits, never by which models they unlock.
- Exact tiers and credit amounts are set from measured run costs.

## 4. Credits

**1 credit = ₹1 of our real cost** for a run:

```
credits = AI cost + sandbox cost            (rounded up)
AI cost      = runs.cost_usd × USD→INR rate
sandbox cost = sandbox minutes × ₹/minute for its size (E2B pricing, a config value)
```

**Infra** (server, worker hosts, Postgres, Redis) is a fixed monthly cost and is never metered. Each plan's price, after GST, minus its included credits must cover infra and leave a margin, even when every credit is used.

Users see credits, never rupees, inside the product. The pricing page also shows them as approximate runs (e.g. "~N runs on Luna").

## 5. Decided against

- **Bring your own API key:** not a SaaS model, and the sandbox and infra are ours anyway.
- **Model tiers as plans** (fast / balanced / best): the model is a choice per run, not something a plan unlocks.
- **Plan price = credits at cost** (e.g. ₹599 buys ₹599 of usage): no margin left for infra.
- **A list of unlimited users in an env setting:** plans in the database do the same, and the admin panel can change them.
- **Calendar-month resets:** each user's cycle runs from their own start date, as a subscription would.

## 6. Admin panel (post-MVP)

For the operator, not users: every user, plan and number in one place, built on the tables above and what runs already record.
- **Users:** list and search, each with their plan, cycle and usage; change plan (writes the subscription with `source = admin`); ban.
- **Plans:** create and edit limits (and, with Pro, price and credits).
- **Statistics:** runs, setups, cost, tokens, durations and outcomes, overall and per user, from `runs` and `onboardings`; the daily spend against the cap.
- **Access:** a `role` on the user (`admin`). Better Auth's admin plugin gives roles, banning and user listing, so those aren't built from scratch.
