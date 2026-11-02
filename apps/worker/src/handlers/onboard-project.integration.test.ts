import { scriptedModel, type ScriptedStep } from "@hobai/agent/testing";
import {
  DbEnvironmentStore,
  findOnboarding,
  findOnboardingEventsAfter,
  getInstallationById,
  markInstallationUninstalled,
  markOnboardingEnded,
  createOnboarding,
  type Db,
} from "@hobai/db";
import { insertProject, testDatabaseOrSkip } from "@hobai/db/testing";
import type { SandboxLabels } from "@hobai/sandbox";
import { FakeSandbox } from "@hobai/sandbox/testing";
import type { OnboardingAnswer, OnboardingEvent } from "@hobai/shared";
import { afterAll, describe, expect, it } from "vitest";
import {
  createEventWriter,
  dbEventRows,
  type Publisher,
} from "../events/event-writer.js";
import { LockLostError } from "../lib/lock-lost.js";
import { fakeGithubApp } from "../testing/fake-github-app.js";
import { createAnswerRouter } from "../onboardings/answer-router.js";
import {
  handleOnboardProject,
  type OnboardProjectDeps,
} from "./onboard-project.js";

const database = await testDatabaseOrSkip("onboard-project handler");

type Handler = (command: string) => object;

const lintBroken: Handler = (command) =>
  command.includes("npm run lint")
    ? { exitCode: 127, stdout: "sh: 1: eslint: not found" }
    : {};

const askAboutLint: ScriptedStep = {
  toolCalls: [
    {
      toolName: "ask_user",
      input: {
        question: "eslint isn't installed. What should I do?",
        options: [{ label: "Don't lint" }, { label: "Install eslint" }],
      },
    },
  ],
};

const finishWithoutLint: ScriptedStep = {
  toolCalls: [
    {
      toolName: "finish_setup",
      input: {
        steps: [{ name: "install", cwd: ".", command: "npm ci" }],
        checks: [{ name: "test", cwd: ".", command: "npm run test" }],
        notes: ["Left out lint: eslint isn't installed."],
      },
    },
  ],
};

function createSandbox(handler: Handler, labels: SandboxLabels[]) {
  return async (l: SandboxLabels) => {
    labels.push(l);
    const sandbox = new FakeSandbox({
      "package.json": JSON.stringify({
        scripts: { lint: "eslint .", test: "node --test" },
      }),
      "package-lock.json": "{}",
    });
    sandbox.execHandler = (command) =>
      command.includes("git rev-parse HEAD")
        ? { stdout: "c0ffee\n" }
        : handler(command);
    return sandbox;
  };
}

describe.skipIf(!database)("onboard-project handler against Postgres", () => {
  const db = database?.db as Db;
  const environments = new DbEnvironmentStore(db);
  afterAll(() => database?.drop());

  async function queuedSetup() {
    const project = await insertProject(db);
    const { onboarding } = await createOnboarding(db, {
      projectId: project.id,
      userId: project.userId,
    });
    return { project, onboardingId: onboarding.id };
  }

  const stored = async (onboardingId: string) =>
    (await findOnboardingEventsAfter(db, onboardingId, 0, 100)).map((event) => [
      event.seq,
      event.type,
    ]);

  function depsFor(
    handler: Handler = () => ({}),
    script: ScriptedStep[] = [],
    {
      answer,
      answerTimeoutMs = 60_000,
      maxDurationMs,
    }: {
      answer?: OnboardingAnswer;
      answerTimeoutMs?: number;
      maxDurationMs?: number;
    } = {},
  ) {
    const answers = createAnswerRouter();
    const labels: SandboxLabels[] = [];
    const logs: { message: string; data?: Record<string, unknown> }[] = [];
    const published: { channel: string; message: OnboardingEvent }[] = [];
    const publisher: Publisher = {
      async publish(channel, message) {
        const event = JSON.parse(message) as OnboardingEvent;
        published.push({ channel, message: event });
        // Answers the way the browser would, once the question is out.
        if (event.type === "question_asked" && answer) {
          setTimeout(() =>
            answers.deliver({
              onboardingId: event.onboardingId,
              questionId: event.questionId,
              answer,
            }),
          );
        }
        return 1;
      },
    };
    const deps: OnboardProjectDeps = {
      db,
      events: createEventWriter({ store: dbEventRows(db), publisher }),
      log: (_level, message, data) => logs.push({ message, data }),
      model: scriptedModel(script).resolved,
      createSandbox: createSandbox(handler, labels),
      github: fakeGithubApp().github,
      answers,
      answerTimeoutMs,
      maxDurationMs,
    };
    return {
      deps,
      publisher,
      published,
      labels,
      logs,
      messages: () => published.map((p) => p.message),
    };
  }

  it("saves the drafted environment, recording the setup and its events", async () => {
    const { project, onboardingId } = await queuedSetup();
    const { deps, published, messages, labels, logs } = depsFor();

    const result = await handleOnboardProject(deps, { onboardingId });

    expect(result?.status).toBe("approved");
    expect(labels).toEqual([
      { kind: "onboarding", projectId: project.id },
      { kind: "onboarding", projectId: project.id },
    ]);
    const environment = await environments.load(project.id);
    expect(environment).toMatchObject({
      version: 1,
      source: "detected",
      config: { meta: { commit: "c0ffee" } },
    });
    const setup = await findOnboarding(db, onboardingId);
    expect(setup).toMatchObject({
      status: "succeeded",
      environmentId: environment?.id,
    });
    expect(setup?.startedAt).toBeInstanceOf(Date);
    expect(setup?.finishedAt).toBeInstanceOf(Date);

    expect(new Set(published.map((p) => p.channel))).toEqual(
      new Set([`onboarding:${onboardingId}`]),
    );
    expect(messages()).toContainEqual(
      expect.objectContaining({
        type: "info",
        message: "Final check in a fresh sandbox…",
        onboardingId,
      }),
    );
    const last = messages().at(-1);
    expect(last).toMatchObject({
      type: "done",
      status: "succeeded",
      version: 1,
      onboardingId,
    });
    const events = await stored(onboardingId);
    expect(events.map(([seq]) => seq)).toEqual(
      events.map((_event, index) => index + 1),
    );
    expect(events.at(-1)).toEqual([last?.seq, "done"]);
    expect(logs).toContainEqual({
      message: "Setup finished",
      data: {
        onboardingId,
        projectId: project.id,
        status: "succeeded",
        version: 1,
      },
    });
  });

  it("saves a new version when the project is set up again", async () => {
    const first = await queuedSetup();
    await handleOnboardProject(depsFor().deps, {
      onboardingId: first.onboardingId,
    });
    const { onboarding } = await createOnboarding(db, {
      projectId: first.project.id,
      userId: first.project.userId,
    });

    const { deps, messages } = depsFor();
    await handleOnboardProject(deps, { onboardingId: onboarding.id });

    expect((await environments.load(first.project.id))?.version).toBe(2);
    expect(messages().at(-1)).toMatchObject({ type: "done", version: 2 });
  });

  it("records the setup agent's events without the runner's run id", async () => {
    const { project, onboardingId } = await queuedSetup();
    const { deps, messages } = depsFor(lintBroken, [finishWithoutLint]);

    await handleOnboardProject(deps, { onboardingId });

    const toolStart = messages().find((m) => m.type === "tool_start");
    expect(toolStart).toMatchObject({ onboardingId, seq: expect.any(Number) });
    expect(toolStart).not.toHaveProperty("runId");
    expect((await stored(onboardingId)).map(([, type]) => type)).toContain(
      "tool_start",
    );
    expect(await environments.load(project.id)).toMatchObject({
      source: "ai",
    });
  });

  it("records a failed setup, without saving anything", async () => {
    const { project, onboardingId } = await queuedSetup();
    const { deps, messages } = depsFor((command) =>
      command.includes("git clone")
        ? { exitCode: 128, stderr: "repository not found" }
        : {},
    );

    await expect(handleOnboardProject(deps, { onboardingId })).rejects.toThrow(
      "Setup of acme/app failed",
    );

    expect(await environments.load(project.id)).toBeNull();
    expect(await findOnboarding(db, onboardingId)).toMatchObject({
      status: "failed",
      errorCode: "setup_failed",
      errorMessage: expect.any(String),
      environmentId: null,
    });
    expect(messages().at(-1)).toMatchObject({
      type: "done",
      status: "failed",
      error: expect.any(String),
    });
  });

  it("fails, and says why, when the App was uninstalled", async () => {
    const { project, onboardingId } = await queuedSetup();
    const installation = await getInstallationById(db, project.installationId);
    await markInstallationUninstalled(db, installation!.installationId);
    const { deps, messages, labels } = depsFor();

    await expect(handleOnboardProject(deps, { onboardingId })).rejects.toThrow(
      "no longer installed",
    );

    expect(messages()).toEqual([
      expect.objectContaining({
        type: "done",
        status: "failed",
        error: expect.stringContaining("no longer installed"),
        seq: 1,
      }),
    ]);
    expect(await findOnboarding(db, onboardingId)).toMatchObject({
      status: "failed",
      errorCode: "github_access",
    });
    expect(labels).toEqual([]);
  });

  it("skips a setup that was cancelled before it started", async () => {
    const { onboardingId } = await queuedSetup();
    await markOnboardingEnded(db, onboardingId, { status: "cancelled" });
    const { deps, published, labels } = depsFor();

    expect(await handleOnboardProject(deps, { onboardingId })).toBeNull();
    expect(published).toEqual([]);
    expect(labels).toEqual([]);
    expect(await stored(onboardingId)).toEqual([]);
  });

  it("throws for a setup that doesn't exist", async () => {
    const { deps, published } = depsFor();
    const onboardingId = "00000000-0000-0000-0000-000000000000";

    await expect(handleOnboardProject(deps, { onboardingId })).rejects.toThrow(
      `Setup ${onboardingId} doesn't exist.`,
    );
    expect(published).toEqual([]);
  });

  it("asks you, waits for your answer, and carries on with it", async () => {
    const { project, onboardingId } = await queuedSetup();
    const { deps, messages } = depsFor(
      lintBroken,
      [askAboutLint, finishWithoutLint],
      { answer: { option: 0 } },
    );

    await handleOnboardProject(deps, { onboardingId });

    const asked = messages().find((m) => m.type === "question_asked");
    expect(asked).toMatchObject({
      question: "eslint isn't installed. What should I do?",
      options: [{ label: "Don't lint" }, { label: "Install eslint" }],
      allowOther: true,
    });
    expect(
      messages().find((m) => m.type === "question_answered"),
    ).toMatchObject({
      questionId: asked?.type === "question_asked" ? asked.questionId : "",
      answer: { option: 0 },
      label: "Don't lint",
    });
    expect(await findOnboarding(db, onboardingId)).toMatchObject({
      status: "succeeded",
      openQuestionId: null,
    });
    expect(
      (await environments.load(project.id))?.config.meta.decisions,
    ).toContainEqual({
      question: "eslint isn't installed. What should I do?",
      answer: "Don't lint",
      auto: false,
    });
  });

  it("stops when a question goes unanswered", async () => {
    const { project, onboardingId } = await queuedSetup();
    const { deps, messages } = depsFor(lintBroken, [askAboutLint], {
      answerTimeoutMs: 50,
    });

    await expect(handleOnboardProject(deps, { onboardingId })).rejects.toThrow(
      "waiting",
    );

    expect(await findOnboarding(db, onboardingId)).toMatchObject({
      status: "failed",
      errorCode: "NO_ANSWER",
      openQuestionId: null,
    });
    expect(messages().at(-1)).toMatchObject({ type: "done", status: "failed" });
    expect(await environments.load(project.id)).toBeNull();
  });

  it("stops at its time limit, without starting another command", async () => {
    const { project, onboardingId } = await queuedSetup();
    const commands: string[] = [];
    const { deps } = depsFor(
      async (command) => {
        commands.push(command);
        if (command.includes("npm ci")) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return {};
      },
      [],
      { maxDurationMs: 20 },
    );

    await expect(handleOnboardProject(deps, { onboardingId })).rejects.toThrow(
      "longer than",
    );

    expect(await findOnboarding(db, onboardingId)).toMatchObject({
      status: "failed",
      errorCode: "TIME_LIMIT",
    });
    expect(commands.filter((c) => c.includes("npm run"))).toEqual([]);
    expect(await environments.load(project.id)).toBeNull();
  });

  it("stops when you press Stop while it waits for you", async () => {
    const { onboardingId } = await queuedSetup();
    const { deps, publisher, published } = depsFor(lintBroken, [askAboutLint]);
    const stop = new AbortController();
    const original = publisher.publish;
    publisher.publish = async (channel, message) => {
      const result = await original(channel, message);
      if (message.includes('"question_asked"')) setTimeout(() => stop.abort());
      return result;
    };

    await handleOnboardProject(deps, { onboardingId }, stop.signal);

    expect(await findOnboarding(db, onboardingId)).toMatchObject({
      status: "cancelled",
      openQuestionId: null,
    });
    expect(published.at(-1)?.message).toMatchObject({
      type: "done",
      status: "cancelled",
    });
  });

  it("stops when you press Stop while it works", async () => {
    const { onboardingId } = await queuedSetup();
    const { deps } = depsFor();
    const stop = new AbortController();
    stop.abort();

    await handleOnboardProject(deps, { onboardingId }, stop.signal);

    expect((await findOnboarding(db, onboardingId))?.status).toBe("cancelled");
  });

  it("records nothing, leaving it to the reaper, when its queue lock was lost", async () => {
    const { onboardingId } = await queuedSetup();
    const { deps, published, logs } = depsFor();
    const lost = new AbortController();
    lost.abort(new LockLostError());

    expect(
      await handleOnboardProject(deps, { onboardingId }, lost.signal),
    ).toBeNull();

    expect((await findOnboarding(db, onboardingId))?.status).toBe("running");
    expect(published.map((p) => p.message.type)).not.toContain("done");
    expect(logs.map((l) => l.message)).toContain(
      "Stopped a setup whose queue lock was lost",
    );
  });
});
