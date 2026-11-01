import {
  DbEnvironmentStore,
  findOnboarding,
  getProject,
  type Db,
} from "@hobai/db";
import type { GithubApp } from "@hobai/github";
import {
  runOnboarding,
  type OnboardingResult,
  type RunOnboardingOptions,
} from "@hobai/runner";
import type {
  OnboardingEndStatus,
  OnboardingEventBody,
  QueuedWork,
  RunEvent,
} from "@hobai/shared";
import type { EventWriter } from "../events/event-writer.js";
import { createEventSink, onboardingEventTarget } from "../events/sink.js";
import { GithubAccessError, repoReadToken } from "../github/repo-token.js";
import type { Log } from "../lib/log.js";
import type { SandboxFactory } from "../lib/sandbox-factory.js";
import type { AnswerRouter } from "../onboardings/answer-router.js";
import { createEventChannel } from "../onboardings/event-channel.js";
import {
  createOnboardingRecord,
  onboardingOutcome,
  type EndedOnboarding,
} from "../onboardings/onboarding-record.js";

/** Waiting for answers included; the same reasoning as a run's RUN_TIME_LIMIT_MS. */
export const SETUP_TIME_LIMIT_MS = 45 * 60_000;

const TIME_LIMIT = (minutes: number): EndedOnboarding => ({
  status: "failed",
  errorCode: "TIME_LIMIT",
  errorMessage: `Setup took longer than ${minutes} minutes and was stopped.`,
});

const NO_ANSWER = (minutes: number): EndedOnboarding => ({
  status: "failed",
  errorCode: "NO_ANSWER",
  errorMessage: `Setup stopped after waiting ${minutes} minutes for an answer.`,
});

export type OnboardProjectDeps = {
  db: Db;
  events: EventWriter;
  log: Log;
  createSandbox: SandboxFactory;
  github: Pick<GithubApp, "repoToken">;
  answers: AnswerRouter;
  /** How long a question waits for its answer before setup stops. */
  answerTimeoutMs: number;
  /** Default SETUP_TIME_LIMIT_MS. */
  maxDurationMs?: number;
} & Pick<RunOnboardingOptions, "model" | "agentLimits">;

/** Null when the setup was no longer queued (e.g. cancelled before it started). */
export async function handleOnboardProject(
  deps: OnboardProjectDeps,
  { onboardingId }: QueuedWork["onboard-project"],
  signal?: AbortSignal,
): Promise<OnboardingResult | null> {
  const { db } = deps;
  const onboarding = await findOnboarding(db, onboardingId);
  if (!onboarding) throw new Error(`Setup ${onboardingId} doesn't exist.`);
  const project = await getProject(db, onboarding.projectId);
  if (!project)
    throw new Error(`Project ${onboarding.projectId} doesn't exist.`);
  const repo = `${project.repoOwner}/${project.repoName}`;

  const record = createOnboardingRecord(db, onboardingId);
  if (!(await record.start())) {
    deps.log("info", "Setup skipped: it isn't queued", { onboardingId });
    return null;
  }

  const sink = createEventSink<RunEvent | OnboardingEventBody>(
    deps,
    onboardingEventTarget(onboardingId),
  );
  const now = () => new Date().toISOString();
  const done = (
    status: OnboardingEndStatus,
    extra: { version?: number; error?: string } = {},
  ) => sink.emit({ type: "done", ts: now(), status, ...extra });
  const flush = () =>
    sink.flush().catch((error: unknown) =>
      deps.log("warn", "Some setup events weren't saved or published", {
        onboardingId,
        error: String(error),
      }),
    );

  let token: string;
  try {
    token = await repoReadToken(deps, project);
  } catch (error) {
    if (error instanceof GithubAccessError) {
      done("failed", { error: error.message });
      await flush();
      await record.fail({ code: "github_access", message: error.message });
    }
    throw error;
  }

  // Setup stops when Stop arrives or a question goes unanswered; which one decides how it ends.
  const stop = new AbortController();
  const stopped = () => stop.abort();
  if (signal?.aborted) stopped();
  signal?.addEventListener("abort", stopped, { once: true });
  let unanswered = false;
  let timedOut = false;
  const maxDurationMs = deps.maxDurationMs ?? SETUP_TIME_LIMIT_MS;
  const timeLimit = setTimeout(() => {
    timedOut = true;
    stop.abort();
  }, maxDurationMs);
  const channel = createEventChannel({
    sink,
    record,
    signal: stop.signal,
    timeoutMs: deps.answerTimeoutMs,
    onTimeout: () => {
      unanswered = true;
      stop.abort();
    },
  });
  const stopReceiving = deps.answers.register(onboardingId, channel.receive);

  const result = await runOnboarding({
    runId: `onboarding-${onboardingId}`,
    source: {
      type: "git",
      url: `https://github.com/${repo}.git`,
      ref: project.defaultBranch,
      token,
    },
    model: deps.model,
    agentLimits: deps.agentLimits,
    createSandbox: () =>
      deps.createSandbox({ kind: "onboarding", projectId: project.id }),
    channel,
    autoApprove: true,
    emit: (event) => sink.emit(event),
    signal: stop.signal,
  }).finally(() => {
    clearTimeout(timeLimit);
    stopReceiving();
    signal?.removeEventListener("abort", stopped);
  });

  const saved =
    result.status === "approved" && result.config
      ? await new DbEnvironmentStore(db).save(
          project.id,
          result.config,
          result.config.meta.source,
        )
      : null;
  const outcome = timedOut
    ? TIME_LIMIT(Math.round(maxDurationMs / 60_000))
    : unanswered
      ? NO_ANSWER(Math.round(deps.answerTimeoutMs / 60_000))
      : onboardingOutcome(result, saved?.id ?? null);
  done(outcome.status, {
    ...(saved ? { version: saved.version } : {}),
    ...(outcome.errorMessage ? { error: outcome.errorMessage } : {}),
  });
  await flush();
  await record.finish(outcome);
  deps.log("info", "Setup finished", {
    onboardingId,
    projectId: project.id,
    status: outcome.status,
    ...(saved ? { version: saved.version } : {}),
  });

  if (outcome.status === "failed") {
    throw new Error(`Setup of ${repo} failed: ${outcome.errorMessage}`);
  }
  return result;
}
