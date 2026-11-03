import type { RunResponse } from "@hobai/shared";
import { describe, expect, it } from "vitest";
import { PRODUCT_NAME, SHORT_NAME } from "@hobai/shared/brand";
import { runOutcome } from "./outcome";

type Task = Parameters<typeof runOutcome>[0]["task"];

const pullRequest = {
  number: 41,
  url: "https://github.com/x/y/pull/41",
  draft: false,
};

const task = (overrides: Partial<Task> = {}): Task => ({
  label: "pr_open",
  pullRequest,
  project: { id: "p1", owner: "ada", name: "dodesk" },
  baseBranch: "main",
  ...overrides,
});

const run = (overrides: Partial<RunResponse> = {}): RunResponse => ({
  id: "r1",
  taskId: "t1",
  trigger: "initial",
  status: "succeeded",
  stage: "deliver",
  model: "m",
  summary: "Added GET /health.",
  checksPassed: true,
  commitSha: "51b0d7e9a3c4",
  error: null,
  steps: 26,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0.21,
  queuedAt: "2026-10-24T10:00:00.000Z",
  startedAt: "2026-10-24T10:00:00.000Z",
  finishedAt: "2026-10-24T10:07:12.000Z",
  durationMs: 432_000,
  changes: null,
  ...overrides,
});

const outcome = (
  t: Partial<Task> = {},
  r: Partial<RunResponse> = {},
  checksDone = true,
) =>
  runOutcome({
    task: task(t),
    run: run(r),
    title: "Add a /health endpoint",
    checksDone,
  });

const failed = (code: string) =>
  outcome(
    { label: "failed", pullRequest: null },
    { status: "failed", error: { code, message: "It broke." } },
  );

describe("runOutcome", () => {
  it("is nothing while the run is queued or running", () => {
    expect(outcome({}, { status: "queued" })).toBeNull();
    expect(outcome({}, { status: "running" })).toBeNull();
  });

  it("gives a ready pull request with its summary and checks", () => {
    expect(outcome()).toEqual({
      state: "pr_ready",
      status: { label: "Succeeded", tone: "ok" },
      notice: null,
      summary: "Added GET /health.",
      showsChecks: true,
      noBranch: false,
      pullRequest: {
        number: 41,
        url: "https://github.com/x/y/pull/41",
        title: "Add a /health endpoint",
        line: `Ready for review · verified commit 51b0d7e by ${SHORT_NAME}[bot] · into main`,
        tone: "ok",
      },
      unfoldSteps: false,
    });
  });

  it("leaves the commit out of the line when there's none", () => {
    expect(outcome({}, { commitSha: null })?.pullRequest?.line).toBe(
      "Ready for review · into main",
    );
  });

  it("shows the checks only when they ran after the work", () => {
    expect(outcome({}, { checksPassed: null }, false)?.showsChecks).toBe(false);
    expect(outcome({}, { checksPassed: false }, false)?.showsChecks).toBe(true);
  });

  it("says why a pull request is a draft", () => {
    const draft = {
      label: "pr_draft",
      pullRequest: { ...pullRequest, draft: true },
    } as const;

    const failing = outcome(draft, { checksPassed: false });
    expect(failing).toMatchObject({ state: "pr_draft", notice: null });
    expect(failing?.pullRequest).toMatchObject({
      line: `Draft: checks still failing · verified commit 51b0d7e by ${SHORT_NAME}[bot] · into main`,
      tone: "warn",
    });

    const stopped = outcome(draft, {
      status: "incomplete",
      error: { code: "steps_limit", message: "Stopped at the steps limit." },
    });
    expect(stopped).toMatchObject({
      state: "pr_draft",
      status: { label: "Incomplete", tone: "warn" },
      notice: { tone: "warn", title: "Stopped at the step limit." },
    });
    expect(stopped?.pullRequest?.line).toMatch(
      /^Draft: stopped before finishing/,
    );
  });

  it("follows the pull request once it's merged or closed", () => {
    expect(outcome({ label: "merged" })).toMatchObject({
      state: "merged",
      pullRequest: { line: "Merged into main", tone: "merged" },
    });
    expect(outcome({ label: "closed" })).toMatchObject({
      state: "closed",
      pullRequest: { line: "Closed without merging", tone: "err" },
    });
  });

  it("says when nothing needed changing", () => {
    expect(outcome({ label: "no_changes", pullRequest: null })).toMatchObject({
      state: "no_changes",
      status: { label: "No changes needed", tone: "neutral" },
      summary: "Added GET /health.",
      showsChecks: false,
      noBranch: true,
      pullRequest: null,
    });
  });

  it("names the limit an incomplete run stopped at", () => {
    const stoppedAt = (code: string) =>
      outcome(
        { label: "no_changes", pullRequest: null },
        { status: "incomplete", error: { code, message: null } },
      );

    expect(stoppedAt("time_limit")).toMatchObject({
      state: "incomplete",
      notice: { title: "Stopped at the time limit." },
      noBranch: true,
    });
    expect(stoppedAt("cost_limit")?.notice?.title).toBe(
      "Stopped at the cost limit.",
    );
    expect(stoppedAt("something_else")?.notice?.title).toBe(
      "Stopped before finishing.",
    );
  });

  it("says where a run failed and what to do about it", () => {
    expect(failed("setup_failed")).toEqual({
      state: "failed",
      status: { label: "Failed", tone: "err" },
      notice: {
        tone: "err",
        title: "Failed during setup",
        text: "It broke.",
        note: "Nothing was pushed.",
        action: {
          label: "Re-run environment setup",
          href: "/projects/p1/environment",
        },
      },
      summary: null,
      showsChecks: false,
      noBranch: false,
      pullRequest: null,
      unfoldSteps: true,
    });

    const headings: [string, string, string | null][] = [
      ["prepare_failed", "Couldn't prepare the sandbox", null],
      ["sandbox_failed", "Couldn't prepare the sandbox", null],
      ["sandbox_busy", "No sandbox was free", null],
      ["checkout_failed", "Couldn't prepare the sandbox", null],
      [
        "no_environment",
        "This project isn't set up",
        "/projects/p1/environment",
      ],
      ["agent_failed", "Failed while working", null],
      ["verify_failed", "Failed while running the checks", null],
      ["deliver_failed", "Couldn't open the pull request", null],
      [
        "github_access",
        "Couldn't reach the repository on GitHub",
        "/projects/p1",
      ],
      ["worker_lost", `${PRODUCT_NAME} stopped unexpectedly`, null],
      ["lost_in_queue", `${PRODUCT_NAME} stopped unexpectedly`, null],
      ["worker_error", `${PRODUCT_NAME} stopped unexpectedly`, null],
      ["something_new", "The run failed", null],
    ];
    for (const [code, title, href] of headings) {
      const notice = failed(code)?.notice;
      expect(notice?.title, code).toBe(title);
      expect(notice?.action?.href ?? null, code).toBe(href);
    }
  });

  it("says the changes are kept when only the pull request failed", () => {
    expect(failed("deliver_failed")?.notice?.note).toBe(
      "The changes are in Changes.",
    );
  });

  it("says when you cancelled it", () => {
    const cancelled = { label: "cancelled", pullRequest: null } as const;

    expect(
      outcome(cancelled, { status: "cancelled", durationMs: 182_000 }),
    ).toMatchObject({
      state: "cancelled",
      status: { label: "Cancelled", tone: "neutral" },
      summary: null,
      notice: {
        title: "You cancelled this run after 3m 02s.",
        note: "The sandbox was removed and nothing was pushed.",
      },
    });
    expect(
      outcome(cancelled, {
        status: "cancelled",
        startedAt: null,
        durationMs: null,
      })?.notice,
    ).toMatchObject({
      title: "You cancelled this run before it started.",
      note: "Nothing was pushed.",
    });
  });
});
