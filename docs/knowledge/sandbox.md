# Sandbox

> Status: **Accepted** · Last updated: 2026-10-30 · Code: `packages/sandbox` · Related: [architecture.md](./architecture.md)

The sandbox is the isolated environment where the agent's work happens: the repository is cloned into it, dependencies are installed, files are edited and checks are run. Nothing the agent does runs on our machines or servers.

## 1. How it fits

```
LLM ──tool call──► agent tools ──► Sandbox interface ──► DockerSandbox  ──► docker exec       ──► local container
                                                     ├─► E2BSandbox     ──► E2B API             ──► cloud sandbox
                                                     └─► DaytonaSandbox ──► Daytona API         ──► cloud sandbox
```

- The LLM only requests tool calls; our tool code decides what runs.
- Tools only know the `Sandbox` interface, never Docker, E2B or Daytona, so swapping providers changes no agent code.
- Local development uses `DockerSandbox`; production uses `E2BSandbox` (§8), and `DaytonaSandbox` (§7) stays available. Selected by `createSandbox({ provider })`; the worker sets it with `SANDBOX_PROVIDER=docker|e2b|daytona`.

## 2. Interface

```ts
interface Sandbox {
  readonly id: string;
  exec(command, { cwd?, timeoutMs?, env? }): Promise<{ exitCode, stdout, stderr, timedOut, truncated }>;
  readFile(path): Promise<string>;
  writeFile(path, content): Promise<void>;
  listFiles(path, { maxDepth? }): Promise<FileEntry[]>;
  destroy(): Promise<void>;
}
```

- The repository lives in `/workspace`; relative paths resolve against it.
- Keeping paths **inside** `/workspace` is the tools' responsibility; the sandbox is a plain executor.
- A failing command is a normal result (`exitCode ≠ 0`). Only infrastructure problems throw.
- Docker-only extras (e.g. `copyIn` for local folders) live on `DockerSandbox`, not the interface, because remote providers can't support them.

## 3. Decisions

| Area | Decision |
|---|---|
| Base image | `hobai-base` from `node:24-bookworm` + ripgrep + fd + corepack (pnpm, yarn). Minimal: the base already has git, curl, python3, make/gcc. |
| Node version | Node 24 only (see TODO). |
| Environment | `CI=true` and `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` for every command, so test runners and corepack never wait for input. |
| User | Non-root `agent` user; git identity `hobai <bot@hobai.app>`. |
| Resources | 4 GB memory, 2 CPUs, 512 process limit per container (configurable via `resources`). Daytona: 2 CPUs, 4 GB, 10 GB disk, set on the snapshot. E2B: 2 CPUs, 4 GB, set on the template. |
| Network | Docker and E2B: full internet access (needed for clone and package installs). Daytona: limited by our tier; see §7 "Network". |
| Host access | No volume mounts, no Docker socket, no secrets in phase 1. Local folders are **copied** in, never mounted. |
| Exec timeout | Default 2 min, max 10 min. Enforced **inside** the container with `timeout` (killing the host-side docker client would leave the process running). Host-side kill at timeout + 15 s as a backstop. |
| Output cap | 1 MB per stream; over the cap, the first and last 512 KB are kept and `truncated: true`. |
| readFile limit | 10 MB; larger files throw instead of returning truncated content (writing that back would corrupt the file). |
| writeFile | Content sent via stdin, never in the command line: no quoting or injection issues. |
| Lifecycle | One sandbox per run (two per onboarding). `destroy()` in `finally`. Docker: main process is `sleep 7200`, so a container exits by itself after 2 h even if cleanup never runs. Daytona: see §7; E2B: killed after 1 hour (§8). |
| Lost runs | When a run's worker dies, the reaper reconnects to its sandbox (`connectSandbox`), saves its diff, then **parks** it (`parkSandbox`): Daytona stops it and keeps it for the retention period, so the run could be resumed there; Docker and E2B delete it, since a stopped container or paused E2B sandbox never expires. |
| Labels | Every sandbox has `hobai=1`, plus what the caller passes: the worker adds `kind=run, runId` or `kind=onboarding, projectId`, so the reaper can find sandboxes whose work is over. |
| Errors | `SandboxUnavailableError` (Docker not running / image missing / Daytona or E2B key rejected), `SandboxCreateError`, `SandboxBusyError` (a `SandboxCreateError`: the provider has no room right now, a quota or rate limit; the worker waits and tries again), `SandboxGoneError`, `SandboxFileError`. |

## 4. Code layout

```
packages/sandbox/
├── images/base/Dockerfile          hobai-base image
└── src/
    ├── index.ts                    public API (re-exports only)
    ├── create-sandbox.ts           createSandbox() — picks the provider
    ├── core/                       contract shared by every provider
    │   ├── types.ts                Sandbox interface and option/result types
    │   ├── errors.ts               SandboxError and subclasses
    │   └── limits.ts               exec timeouts, readFile limit, lifetime
    ├── lib/                        provider-agnostic helpers
    │   ├── capped-buffer.ts        head + tail output cap
    │   ├── run-process.ts          spawn with stdin, timeout and output cap
    │   ├── shell-quote.ts          single-quote a shell argument
    │   ├── find-files.ts           listFiles' find arguments and output parsing
    │   └── workspace.ts            paths relative to /workspace
    ├── providers/
    │   ├── docker/
    │   │   ├── docker-sandbox.ts   DockerSandbox
    │   │   ├── docker-cli.ts       docker CLI wrapper, "container gone" detection
    │   │   └── constants.ts        image, label, resource defaults, timeouts
    │   ├── daytona/
    │   │   ├── daytona-sandbox.ts  DaytonaSandbox
    │   │   ├── exec-script.ts      the exec wrapper and its output parser
    │   │   └── constants.ts        snapshot, labels, auto-stop, timeouts
    │   └── e2b/
    │       ├── e2b-sandbox.ts      E2BSandbox
    │       └── constants.ts        template, metadata, environment, lifetime, timeouts
    ├── scripts/
    │   ├── build-snapshot.ts       pnpm sandbox:build-snapshot
    │   └── build-template.ts       pnpm sandbox:build-template
    └── testing/                    @hobai/sandbox/testing
        ├── fake-sandbox.ts         FakeSandbox: in-memory files, scripted exec
        └── docker.ts               dockerSandboxOrSkip(): a DockerSandbox, or null to skip without Docker (fails in CI)
```

Tests sit next to the code: `*.test.ts` are fast unit tests, `*.integration.test.ts` need Docker.

## 5. Commands

| Command | What it does |
|---|---|
| `pnpm sandbox:build-image` | Build `hobai-base` (needed once, and after Dockerfile changes) |
| `pnpm sandbox:build-snapshot` | Build the `hobai-base` snapshot on Daytona from the same Dockerfile, then check a sandbox made from it (needed once per account, and `--replace` after Dockerfile changes). Reads `DAYTONA_*` from `apps/worker/.env`. |
| `pnpm sandbox:build-template` | Build the `hobai-base` template on E2B from the same Dockerfile, then check a sandbox made from it (needed once per account, and `--replace` after Dockerfile changes). Reads `E2B_API_KEY` from `apps/worker/.env`. |
| `pnpm sandbox:clean` | Remove any leftover Docker containers labelled `hobai=1` |
| `docker exec -it <id> bash` | Inspect a running sandbox (e.g. one kept with `--keep`) |

## 6. Testing

Unit tests (`src/lib/*.test.ts`) need nothing. Integration tests (`src/providers/docker/docker-sandbox.integration.test.ts`) run against real Docker. Locally they skip (with a warning) if Docker isn't running or the image isn't built; in CI they fail instead. CI builds the image before running tests.

Daytona and E2B have **no automated tests against the real service**, by decision: every run would create billable sandboxes. E2B's are described in §8. `DaytonaSandbox` is tested with a fake client whose answers were recorded once from a real sandbox (`exec-script.test.ts`, `daytona-sandbox.test.ts`). The real service is checked by hand: `pnpm sandbox:build-snapshot` runs commands through `DaytonaSandbox`, and a worker run with `SANDBOX_PROVIDER=daytona` covers the rest (§7).

## 7. Daytona

| Method | DockerSandbox | DaytonaSandbox |
|---|---|---|
| create | `docker run hobai-base` | `daytona.create` from the `hobai-base` snapshot |
| exec | `docker exec … timeout … bash -lc` | one `process.executeCommand` running a wrapper (below) |
| readFile / writeFile | `docker exec cat` / stdin | `fs.downloadFile` / `fs.uploadFile` (upload creates missing folders) |
| listFiles | `docker exec find` | the same `find`, through `exec` |
| destroy | `docker rm -f` | `sandbox.delete()`; "already gone" is ignored |

Decisions, from a probe of the real API (SDK 0.225):

| Area | Decision |
|---|---|
| Snapshot | `hobai-base`, built on Daytona from **the same Dockerfile** as the Docker image, so both providers have the same tools, `agent` user and writable `/workspace` (checked on a real sandbox). 2 CPUs, 4 GB, 10 GB disk. Daytona's default snapshot (1 CPU, 1 GB, no `/workspace`) isn't used. |
| exec | Daytona returns stdout and stderr **mixed together**, but `diff` and `search` parse stdout. So exec sends a wrapper: the command goes in the env var `CG_CMD` (no quoting), runs under `timeout -k` like Docker, with stderr redirected to a temp file; the wrapper then prints a random marker, the exit code and the stderr file, and the provider splits on the marker. |
| Timeouts | Same limits as Docker: exit 124 means timed out. The SDK's own timeout (ours + 20 s) is a backstop; its timeout error becomes `timedOut: true`, not a failure. |
| Output | Daytona doesn't cap output; the provider applies Docker's 1 MB head + tail cap. |
| Safety nets | `autoStopInterval: 30` (stopped after 30 idle minutes), `autoDeleteInterval` = retention (`SANDBOX_RETENTION_HOURS`, default 4: deleted that long after stopping), `ttlMinutes` = 2 h + 30 min + retention (destroyed then, whatever its state). An orphaned sandbox stops and deletes itself even if the reaper never runs. The deletion after retention is from the SDK's documentation; it wasn't checked on the real service. |
| Errors | Key rejected → `SandboxUnavailableError`; a full quota (a 403 saying "limit exceeded", matched by its message) or a 429 → `SandboxBusyError`; other create failures → `SandboxCreateError`; missing file → `SandboxFileError`; sandbox no longer exists → `SandboxGoneError` (later calls fail without contacting Daytona). |
| Network | On our tier (1–2), a sandbox reaches only Daytona's [essential services](https://www.daytona.io/docs/en/network-limits): package and container registries, Git hosts, CDNs, system package managers. Anything else fails, e.g. Prisma's engine download from `binaries.prisma.sh` (`ECONNRESET`). The limit is set for the whole organization and a sandbox can't loosen it. Full internet needs Tier 3, which needs a $500 top-up: not worth it now. We won't route traffic around the limit through our own servers (our server isn't reachable either, and it would break Daytona's terms). A repo that needs other hosts gets a setup that says which check couldn't run and why. If this blocks too many repos, we add another sandbox provider rather than pay for the tier. |
| Connection | `apiKey`, `apiUrl` and `target` are passed explicitly (`createSandbox({ provider: "daytona", connection })`): the SDK refuses a `DAYTONA_API_URL` it can only find in a `.env` file. |

Measured on `octocat/Hello-World` (2026-10-20): onboarding 22 s and a run 23 s (5 agent steps, $0.0004 model cost), sandboxes deleted afterwards. A sandbox from Daytona's default snapshot starts in about 1.3 s.

## 8. E2B

Production uses E2B (`SANDBOX_PROVIDER=e2b`); Daytona (§7) stays available with `SANDBOX_PROVIDER=daytona`.

**Why:** Daytona's network limit (§7) breaks every repo that downloads from a host outside its essential services, during install or at runtime: Prisma engines, Puppeteer's Chrome, Cypress, packages fetching from their own CDN, tests calling real APIs. These are common in TypeScript repos, and full internet on Daytona needs Tier 3 ($500 top-up). E2B gives full internet on every plan, at the same price per hour.

**Comparison** (checked 2026-10-30):

| | E2B | Daytona |
|---|---|---|
| Isolation | Firecracker microVM, own kernel | Docker container, shared kernel |
| Internet | Full by default, every plan; optional allowlist (`network.allowOut` / `denyOut`) | Essential services only below Tier 3 |
| Price (2 vCPU, 4 GB) | ≈ $0.166/h; storage free | ≈ $0.166/h, plus disk after 5 GiB |
| Free credit | $100 once (Hobby) | $200 |
| Plans | Hobby: free, 20 at once. Pro: $150/month, 100 at once | Pay as you go, quota by tier |
| Longest sandbox | Hobby 1 h, Pro 24 h (pausing resets it) | No cap; ours set by us |
| Image | Template from the Dockerfile (`Template().fromDockerfile()`) | Snapshot from the Dockerfile |
| Exec output | stdout and stderr separate | Mixed (hence the wrapper in §7) |
| Labels | `metadata`, filtered server-side by `Sandbox.list` | Labels |
| Safety net | Killed when its timeout passes | Auto-stop, auto-delete, TTL |
| Paused sandboxes | Kept until killed: no auto-delete | Deleted after the retention period |

| Method | DockerSandbox | E2BSandbox |
|---|---|---|
| create | `docker run hobai-base` | `Sandbox.create` from the `hobai-base` template, with the labels as metadata |
| exec | `docker exec … timeout … bash -lc` | `commands.run` of the same `timeout … bash -lc` (the command shell-quoted) |
| readFile / writeFile | `docker exec cat` / stdin | `files.read` (bytes) / `files.write` (creates missing folders) |
| listFiles | `docker exec find` | the same `find`, through `exec` |
| destroy | `docker rm -f` | `kill()`; an already gone sandbox is fine |

Decisions, from a probe of the real API (SDK 2.62):

| Area | Decision |
|---|---|
| Template | `hobai-base`, built on E2B from **the same Dockerfile** (2 vCPU, 4 GB) by `pnpm sandbox:build-template`, which then checks a sandbox made from it. Commands run as `agent` in `/workspace`, as on Docker. |
| Environment | E2B doesn't apply the Dockerfile's `ENV` to commands, so the sandbox is created with `CI=true` and `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` (checked by `build-template`). |
| exec | E2B throws on a non-zero exit (`CommandExitError`, which carries stdout, stderr and the code); the provider turns it back into a result. A missing `cwd` is refused by E2B and returned as a failed command (exit 1). Same timeouts as Docker (exit 124 means timed out); the SDK's own timeout (ours + 20 s) is a backstop and becomes `timedOut: true`. E2B doesn't cap output; the provider applies Docker's 1 MB head + tail cap. |
| Lifetime | 1 hour, the most E2B's Hobby plan allows (2 h on Docker and Daytona); runs and setups end within 45 minutes. E2B kills the sandbox then, even if nothing else does. Pro (24 h, 100 at once) only when usage needs it. |
| Parking | Deleted, like Docker: the diff is already saved and nothing resumes a parked sandbox yet, while a paused E2B sandbox would never expire on its own. When resume is built, parking becomes a pause plus a reaper sweep that kills paused sandboxes older than `SANDBOX_RETENTION_HOURS`. |
| Errors | Key rejected → `SandboxUnavailableError`; a 429, which is how E2B refuses a sandbox past the account's concurrency limit (after the SDK's own 3 quick retries) → `SandboxBusyError`; other create failures (including a missing template) → `SandboxCreateError`; missing file or a directory read as a file → `SandboxFileError`; sandbox killed or timed out → `SandboxGoneError`. E2B's "killed" and "unreachable" errors are subclasses of its `TimeoutError`, so they're never taken for a timed-out command. |
| Network | Full internet (checked: `binaries.prisma.sh` answers). |
| Testing | No automated tests against the real service. `E2BSandbox` is tested with a fake client that answers and throws as the probe recorded (`e2b-sandbox.test.ts`). `pnpm sandbox:build-template` checks the real service by hand. |

## 9. TODO (post-MVP or when evals show the need)

- [ ] Support other Node versions (fnm/nvm in the image, picked from `.nvmrc` / `engines`).
- [ ] bun and other runtimes in the image.
- [ ] Optional image variant with browsers for Playwright.
- [ ] Network allowlist (GitHub, npm registry) for production Docker sandboxes.
- [x] Another sandbox provider with full internet access, since Daytona's network limit blocks too many repos (§7): E2B (§8).
- [ ] Streaming `exec` output (`onOutput` callback) for long commands.
- [ ] Background processes (dev servers) for live previews.
- [x] Cache the image build in CI.
