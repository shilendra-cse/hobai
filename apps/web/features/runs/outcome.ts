import type { RunResponse, TaskDetail } from "@hobai/shared";
import { PRODUCT_NAME, SHORT_NAME } from "@hobai/shared/brand";
import { formatDuration } from "@/lib/format";
import { environmentPath, projectPath } from "@/lib/routes";

export type OutcomeState =
  | "pr_ready"
  | "pr_draft"
  | "merged"
  | "closed"
  | "no_changes"
  | "incomplete"
  | "failed"
  | "cancelled";

export type OutcomeTone = "neutral" | "ok" | "warn" | "err" | "merged";

export type OutcomeNotice = {
  tone: "warn" | "err" | "neutral";
  title: string;
  text: string | null;
  /** A line under the text, e.g. what was or wasn't pushed. */
  note: string | null;
  action: { label: string; href: string } | null;
};

export type RunOutcome = {
  state: OutcomeState;
  /** The run card's badge. */
  status: { label: string; tone: OutcomeTone };
  notice: OutcomeNotice | null;
  summary: string | null;
  showsChecks: boolean;
  /** "No branch or pull request was created." */
  noBranch: boolean;
  pullRequest: {
    number: number;
    url: string;
    title: string;
    line: string;
    tone: Exclude<OutcomeTone, "neutral">;
  } | null;
  /** A failed run starts with its stages shown. */
  unfoldSteps: boolean;
};

const LIMITS: Record<string, string> = {
  steps_limit: "Stopped at the step limit.",
  time_limit: "Stopped at the time limit.",
  cost_limit: "Stopped at the cost limit.",
};

const FAILURE_TITLES: Record<string, string> = {
  prepare_failed: "Couldn't prepare the sandbox",
  sandbox_failed: "Couldn't prepare the sandbox",
  sandbox_busy: "No sandbox was free",
  checkout_failed: "Couldn't prepare the sandbox",
  setup_failed: "Failed during setup",
  no_environment: "This project isn't set up",
  agent_failed: "Failed while working",
  verify_failed: "Failed while running the checks",
  deliver_failed: "Couldn't open the pull request",
  github_access: "Couldn't reach the repository on GitHub",
  worker_lost: `${PRODUCT_NAME} stopped unexpectedly`,
  lost_in_queue: `${PRODUCT_NAME} stopped unexpectedly`,
  worker_error: `${PRODUCT_NAME} stopped unexpectedly`,
  time_limit: "Stopped at the time limit",
};

export const failureTitle = (code: string | undefined) =>
  (code && FAILURE_TITLES[code]) || "The run failed";

function failureAction(
  code: string | undefined,
  projectId: string,
): OutcomeNotice["action"] {
  switch (code) {
    case "setup_failed":
      return {
        label: "Re-run environment setup",
        href: environmentPath(projectId),
      };
    case "no_environment":
      return { label: "Set it up", href: environmentPath(projectId) };
    case "github_access":
      return { label: "Check the project", href: projectPath(projectId) };
    default:
      return null;
  }
}

function prLine(
  state: OutcomeState,
  run: RunResponse,
  baseBranch: string,
): string {
  const commit = run.commitSha
    ? ` · verified commit ${run.commitSha.slice(0, 7)} by ${SHORT_NAME}[bot]`
    : "";
  switch (state) {
    case "pr_draft":
      return `Draft: ${run.status === "incomplete" ? "stopped before finishing" : "checks still failing"}${commit} · into ${baseBranch}`;
    case "merged":
      return `Merged into ${baseBranch}`;
    case "closed":
      return "Closed without merging";
    default:
      return `Ready for review${commit} · into ${baseBranch}`;
  }
}

const PR_STATES = {
  pr_open: { state: "pr_ready", tone: "ok" },
  pr_draft: { state: "pr_draft", tone: "warn" },
  merged: { state: "merged", tone: "merged" },
  closed: { state: "closed", tone: "err" },
} as const satisfies Partial<
  Record<TaskDetail["label"], { state: OutcomeState; tone: OutcomeTone }>
>;

const isPrLabel = (
  label: TaskDetail["label"],
): label is keyof typeof PR_STATES => label in PR_STATES;

function runStatus(run: RunResponse, hasPr: boolean): RunOutcome["status"] {
  switch (run.status) {
    case "incomplete":
      return { label: "Incomplete", tone: "warn" };
    case "failed":
      return { label: "Failed", tone: "err" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    default:
      return hasPr
        ? { label: "Succeeded", tone: "ok" }
        : { label: "No changes needed", tone: "neutral" };
  }
}

/** How a finished run turned out: what its card and result message say. Null while it runs. */
export function runOutcome({
  task,
  run,
  title,
  checksDone,
}: {
  task: Pick<TaskDetail, "label" | "pullRequest" | "project" | "baseBranch">;
  run: RunResponse;
  /** The task's title as the page shows it (the run may have just renamed it). */
  title: string;
  /** The run's events recorded the checks after its work. */
  checksDone: boolean;
}): RunOutcome | null {
  if (run.status === "queued" || run.status === "running") return null;

  const base = {
    status: runStatus(run, task.pullRequest !== null),
    summary: run.summary,
    showsChecks: false,
    noBranch: false,
    pullRequest: null,
    unfoldSteps: false,
  };
  const limit =
    run.status === "incomplete" && run.error
      ? LIMITS[run.error.code]
      : undefined;
  const limitNotice: OutcomeNotice | null =
    run.status === "incomplete"
      ? {
          tone: "warn",
          title: limit ?? "Stopped before finishing.",
          text: null,
          note: null,
          action: null,
        }
      : null;

  if (run.status === "failed") {
    return {
      ...base,
      state: "failed",
      summary: null,
      notice: {
        tone: "err",
        title: failureTitle(run.error?.code),
        action: failureAction(run.error?.code, task.project.id),
        text: run.error?.message ?? null,
        note:
          run.error?.code === "deliver_failed"
            ? "The changes are in Changes."
            : "Nothing was pushed.",
      },
      unfoldSteps: true,
    };
  }

  if (run.status === "cancelled") {
    const started = run.startedAt !== null;
    return {
      ...base,
      state: "cancelled",
      summary: null,
      notice: {
        tone: "neutral",
        title:
          started && run.durationMs !== null
            ? `You cancelled this run after ${formatDuration(run.durationMs)}.`
            : started
              ? "You cancelled this run."
              : "You cancelled this run before it started.",
        text: null,
        note: started
          ? "The sandbox was removed and nothing was pushed."
          : "Nothing was pushed.",
        action: null,
      },
    };
  }

  const pr =
    isPrLabel(task.label) && task.pullRequest
      ? { ...PR_STATES[task.label], ...task.pullRequest }
      : null;
  if (!pr) {
    return {
      ...base,
      state: run.status === "incomplete" ? "incomplete" : "no_changes",
      notice: limitNotice,
      noBranch: true,
    };
  }
  return {
    ...base,
    state: pr.state,
    notice: limitNotice,
    showsChecks: checksDone || run.checksPassed !== null,
    pullRequest: {
      number: pr.number,
      url: pr.url,
      title,
      line: prLine(pr.state, run, task.baseBranch),
      tone: pr.tone,
    },
  };
}
