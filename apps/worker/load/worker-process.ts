// The measured process: a real worker, with the load sandbox and a fake GitHub, and the probe.
import { parseConfig } from "../src/config.js";
import { createLog } from "../src/lib/logger.js";
import { startWorker } from "../src/start-worker.js";
import { fakeGithubApp } from "../src/testing/fake-github-app.js";
import { parseLoadEnv } from "./load-env.js";
import { LoadSandbox } from "./load-sandbox.js";
import type { ChildMessage } from "./messages.js";
import { startWorkerProbe } from "./probe.js";

const send = (message: ChildMessage) => process.send?.(message);

const config = parseConfig(process.env);
const log = createLog({ level: config.logLevel, pretty: false });
process.on("unhandledRejection", (reason) =>
  log("error", "Unhandled promise rejection", { error: String(reason) }),
);

const timeScale = parseLoadEnv(process.env).LOAD_TIME_SCALE;
const worker = await startWorker(config, log, {
  createSandbox: async () => new LoadSandbox({ timeScale }),
  github: fakeGithubApp().github,
});
const stopProbe = startWorkerProbe({
  intervalMs: 1_000,
  poolStats: worker.poolStats,
  send: (sample) => send({ type: "worker-sample", sample }),
});
send({ type: "ready" });

process.once("SIGTERM", () => {
  stopProbe();
  void worker.stop().then(() => process.exit(0));
});
