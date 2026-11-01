// The fake OpenAI server in a process of its own, so its CPU isn't counted as the worker's.
import { startFakeOpenAI } from "@hobai/agent/testing";
import { parseLoadEnv } from "./load-env.js";
import type { ChildMessage } from "./messages.js";
import { processSampler } from "./probe.js";
import { loadReply } from "./profiles.js";

const send = (message: ChildMessage) => process.send?.(message);

const settings = parseLoadEnv(process.env);
const timeScale = settings.LOAD_TIME_SCALE;
const fake = await startFakeOpenAI({
  reply: loadReply(settings.LOAD_PROFILE, timeScale),
  // 0 sends a whole reply at once, which is what no delays means.
  tokensPerSecond:
    timeScale === 0 ? 0 : settings.LOAD_TOKENS_PER_SECOND / timeScale,
  cachedInputShare: 0.9,
});

const sample = processSampler();
const timer = setInterval(
  () => send({ type: "fake-sample", sample: sample() }),
  1_000,
);
send({ type: "ready", url: fake.url });

process.once("SIGTERM", () => {
  clearInterval(timer);
  void fake.close().then(() => process.exit(0));
});
