# Plans & Billing

> Status: **Accepted** (open items in §8) · Last updated: 2026-11-06 · Related: [requirements.md](./requirements.md), [development-plan.md](./development-plan.md), [database.md](./database.md) (`plans`, `subscriptions`), [api.md](./api.md), [ui.md](./ui.md) (pricing page, usage)

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

- **Plan** (`plans`): a slug, a name, and its limits: runs per cycle (`null` = no limit) and concurrent runs. Seeded with `free` (10 runs, 1 at a time) and `unlimited` (no run limit, 3 at a time; internal, for the author). Paid plans add a price, included credits and the modes they unlock (§3).
- **Subscription** (`subscriptions`): which plan a user is on, and their current cycle (`period_start`, `period_end`). Every user is on `free` from signup: the subscription is created the first time it's needed (`ensureSubscription`), its cycles counted from the user's `created_at`, so existing users need no backfill. `source` says how they got it: `signup`, `admin`, later `payment`.
- **Cycle:** a month long, from the user's own start date: signed up on the 25th, it resets on the 25th (on a shorter month, its last day). When a cycle has ended, the next request that needs it moves it to the cycle containing now (months without a request are skipped). When paid plans come, the payment provider's billing period becomes the same `period_start` / `period_end`.
- **Changing plan:** `pnpm admin:set-plan <email> <plan>` (by email, since accounts don't store the GitHub login; the author puts themself on `unlimited`); later the admin panel's button does the same. The cycle stays as it is.

### What counts as a run (free tier)
Every task run started in the current cycle, except those that failed through hobai's fault: `queue_unavailable`, `worker_error`, `worker_lost`, `stalled`, `checkout_failed`, `sandbox_failed` and `sandbox_busy` (no sandbox was free, even after waiting). Cancelled runs and runs where the agent failed count; they still cost. **Setups never count.** Usage isn't stored as a counter; it's counted from `runs`, so it can't drift.

### The limits
Checked when a task starts (`POST /projects/:id/tasks`), together with creating the task, in one transaction locked per user, so two quick clicks can't both get through.

| Limit | From | Over the limit | Message |
|---|---|---|---|
| Tasks running at once | the plan (`free`: 1) | `409 RUN_IN_PROGRESS` | "You already have a task running. Wait for it to finish, or cancel it." |
| Runs per cycle | the plan (`free`: 10) | `429 RUN_LIMIT_REACHED` | "You've used all 10 runs this cycle. They reset on 25 Nov." |
| Daily spend, all users together | `DAILY_SPEND_CAP_USD` (default $5): model cost of today's runs and setups (UTC day) | `503 DAILY_CAPACITY_REACHED` | "hobai has reached today's capacity. Try again tomorrow." |

The daily cap is also checked when a setup starts, since setups spend too. It protects hobai's own costs, so it applies to every plan, `unlimited` included. It counts model cost only: sandbox minutes aren't recorded per run yet (usage tracking, §9, adds them).

### Usage in the app
`GET /me/usage` returns the plan, runs used and the limit, the concurrency limit, and when the cycle resets. The web app shows it in **Usage & limits** ([ui.md](./ui.md)).

## 3. Paid plans

- **Subscription:** a fixed monthly price, starting at **₹599** (incl. GST), with higher tiers above it. It includes credits (§4) and unlocks modes (§5).
- **What a plan sets:** its price, its included credits per cycle, how many tasks can run at once, and which modes the user can pick.
- **Free tier** stays as in §1: 10 runs a cycle, counted in runs, not credits.
- **Payments:** Dodo Payments. Checkout, the subscription switching the plan (`source = payment`), renewals and failed payments; the provider's billing period becomes the cycle (§2).
- **Top-ups** (after launch): more credits when the included ones run out, at the same rate per credit.
- Which modes each plan unlocks, and the exact prices and credit amounts, are set from measured costs (§8).

## 4. Credits

- **A run uses credits by its real cost:** the AI cost of every model call in it, plus its sandbox time at the size's price per minute. The model, the task's size and the mode all change how many credits a run uses.
- **A run always uses the user's credits**, whichever model the judge picks (§5), even one above what the user's mode normally reaches.
- **Setups use credits on paid plans**, by their real cost like runs. On the free tier they stay free. Runs and setups that fail through hobai's fault (the list in §2) use none.
- **Margin:** plans are sized so a user who uses every credit roughly breaks even, and a typical user (who uses part of their allowance) leaves ~70% margin. Margin is measured after GST and payment fees.
- **Infra** (server, worker hosts, Postgres, Redis) is a fixed monthly cost, never metered; plan prices cover it.
- **Users see credits, never rupees,** inside the product: on run cards, in live events, in the API and on the billing page.
- A run is refused when the balance is empty. Rough sizing, from estimates only: ₹599 ≈ 500 credits, ₹1,499 ≈ 1,250 credits.

## 5. Modes and model routing

### Modes
The user picks a **mode** for a run: **Optimized**, **Balanced** or **High**. The plan decides which modes they can pick. The mode tells the judge what the user values (cost, balance, quality); it is guidance, not a rule.

### Categories
Four bands of capability and cost. Each has a main model and a backup from a different provider; if the main's provider is down, the run uses the backup.

| Category | Main | Backup |
|---|---|---|
| **Light** | GPT-6 Luna | MiMo V2.6 Flash |
| **Capable** | DeepSeek V4.1 Flash | GLM 5.3 Flash |
| **Strong** | GPT-6.1 Sol | Kimi K3.1 Pro |
| **Frontier** | Kimi K3.1 Pro | Gemini 4 Carbon |

Candidates, chosen by solved tasks per rupee from one same-harness source, with sandbox time counted ([Vals AI](https://www.vals.ai/benchmarks) Terminal-Bench 2.1 for everyday tasks and 4.0 for hard ones, Nov 2026), open and closed models compared together. Our eval run (§9) confirms or replaces them. Categories organise the model list; they don't route.

| Model | TB 2.1 solved / all-in cost per task | TB 4.0 solved / all-in cost per task |
|---|---|---|
| GPT-6 Luna | 73.0% / ₹4.3 | 13.6% / ₹39 |
| MiMo V2.6 Flash | 76.4% / ₹5.2 | 24.2% / ₹53 |
| DeepSeek V4.1 Flash | 74.5% / ₹11 | 31.8% / ₹58 |
| GLM 5.3 Flash | 62.9% / ₹6.4 | 37.4% / ₹122 |
| GPT-6.1 Sol | — | 55.1% / ₹162 |
| Kimi K3.1 Pro | — | 63.6% / ₹414 |
| Gemini 4 Carbon | — | 63.1% / ₹667 |

### The judge
A cheap LLM (GPT-6 Luna to start) runs before every run, after checkout, and **picks the model itself**.
- **It gets a goal, not rules:** pick the model most likely to complete this task well, at the lowest cost, given what the user values. No fixed mapping from task type or difficulty to a model; a prompt of if-else rules would waste its judgement.
- **It gets facts:** each model's measured results, cost and speed, and later hobai's own record per model (runs, success rate, cost, where it failed); no "use for X" labels.
- **It explores the repo** with read-only tools: the code the task involves, its tests, the history. Difficulty is judged for this task in this repo; a trivial task in a large repo is still trivial.
- **It sees its own track record:** similar past tasks, the model it chose, and how those runs went.
- **It returns** the model, the difficulty it saw, and its reasoning, all logged with the run.
- **Our code checks facts only:** the model exists and is available; otherwise the category's backup.
- **No hard ceiling:** it may pick a model above what the user's mode normally reaches when the task needs it (the run still uses the user's credits, §4).
- It starts in **shadow mode**: it runs and records its choice, the run still uses Luna, and its choices are compared with outcomes before they're used.

### Hosting
**OpenRouter**, one API for every model (open and closed), restricted to hosts that don't train on or keep our data. Never the open models' makers' own China-hosted APIs. Models that carry real volume may later move to direct hosting (e.g. DeepInfra, which serves all four open candidates) to save OpenRouter's fee; model IDs are catalog settings, so moving is small.

## 6. Decided against

- **Bring your own API key:** not a SaaS model, and the sandbox and infra are ours anyway.
- **The user picking a model per run:** replaced by modes and the judge (§5).
- **A hard ceiling per plan or mode:** the judge can go higher when the task needs it.
- **Fixed routing rules or a scoring formula** (dimensions × weights → category): additive scores push trivial tasks up (a comment in a large repo), and rules waste the judge's intelligence.
- **A dedicated classifier (TypeSafe's Jev):** fast and cheap, but a cheap LLM can reason, use tools, explain its choice, and adds no new vendor seeing users' code.
- **The open models' makers' own APIs:** hosted in China, and users' code would go there; US hosts charge about the same.
- **70% margin built into every credit** (a run uses ~3× its cost): with strong models, a plan would hold only a handful of runs.
- **Plan price = credits at cost** (e.g. ₹599 buys ₹599 of usage, every credit used): no margin left for infra.
- **A list of unlimited users in an env setting:** plans in the database do the same, and the admin panel can change them.
- **Calendar-month resets:** each user's cycle runs from their own start date, as a subscription would.

## 7. Admin panel (after launch)

For the operator, not users: every user, plan and number in one place, built on the tables above and what runs already record.
- **Users:** list and search, each with their plan, cycle and usage; change plan (writes the subscription with `source = admin`); ban.
- **Plans:** create and edit limits, price, credits and modes.
- **Statistics:** runs, setups, cost, tokens, sandbox time, models chosen, durations and outcomes, overall and per user, from usage tracking; the daily spend against the cap.
- **Access:** a `role` on the user (`admin`). Better Auth's admin plugin gives roles, banning and user listing, so those aren't built from scratch.

## 8. Open

- **Which modes each plan unlocks, and the prices and credit amounts:** after the eval and a few weeks of usage data.
- **The judge's exact inputs and limits** (steps, tools, tokens): settled in its own proposal.

## 9. Build order

| # | Piece | What it delivers | Needs |
|---|---|---|---|
| 1 | Usage tracking | Per run and setup, per user: model, tokens (incl. cached), model cost, sandbox time and size, outcome. Survives deleting a project or task. Nothing visible to users. | — |
| 2 | More model providers | The catalog runs models through OpenRouter, each with its own price. | — |
| 3 | Eval on the candidates | §5's models on hobai's eval tasks: solve rate, cost, time. The first model facts for the judge. | 1, 2 |
| 4 | Judge, shadow mode | The judge records its choice and reasoning; runs still use Luna. | 1, 3 |
| 5 | Judge live + modes | Its choice is used, with backup fallback; users pick a mode; its track record feeds back. | 4 |
| 6 | Credits and plans | Credits per run and setup from usage; a balance per cycle; plans get price, credits and modes; refused when out of credits. | 1, 5 |
| 7 | Credits instead of cost for users | Run cards, live events and the API show credits; `cost_usd` no longer reaches users. | 6 |
| 8 | Payments (Dodo) | Checkout, plan switching, renewals, failed payments. | 6 |
| 9 | Billing page | Plan, credits left, upgrade, receipts. | 6, 8 |
| After launch | Top-ups, admin panel (§7) | | 6, 8 |

Users can pay once 9 is done. 1 and 2 can be built side by side.
