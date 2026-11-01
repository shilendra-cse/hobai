import { fork } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { childMessage, type ChildMessage } from "./messages.js";

const STOP_GRACE_MS = 10_000;

export type Child = {
  /** The url it sent with "ready", if any. */
  ready: Promise<string | undefined>;
  exited: Promise<number | null>;
  /** Asks it to stop; kills it if it hasn't after a grace period, or at once with `force`. */
  stop(options?: { force?: boolean }): Promise<void>;
};

/** Starts one of the load processes in this folder, with tsx, reporting over IPC. */
export function startChild(
  script: string,
  options: {
    env: Record<string, string>;
    execArgv?: string[];
    onMessage: (message: ChildMessage) => void;
    onOutput?: (line: string) => void;
  },
): Child {
  const child = fork(path.join(import.meta.dirname, script), [], {
    env: options.env,
    execArgv: ["--import", "tsx", ...(options.execArgv ?? [])],
    stdio: ["ignore", "pipe", "inherit", "ipc"],
  });
  if (child.stdout) {
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => options.onOutput?.(line));
  }

  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  const ready = new Promise<string | undefined>((resolve, reject) => {
    child.on("message", (raw) => {
      const parsed = childMessage.safeParse(raw);
      if (!parsed.success) {
        console.warn(
          `Ignored a message from ${script}: ${parsed.error.message}`,
        );
        return;
      }
      if (parsed.data.type === "ready") resolve(parsed.data.url);
      else options.onMessage(parsed.data);
    });
    void exited.then((code) =>
      reject(
        new Error(`${script} exited with code ${code} before it was ready.`),
      ),
    );
  });

  return {
    ready,
    exited,
    async stop({ force = false } = {}) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(force ? "SIGKILL" : "SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
      await exited;
      clearTimeout(timer);
    },
  };
}
