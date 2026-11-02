import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Log } from "./log.js";
import { describeError } from "./describe-error.js";

export type HealthServer = { port: number; close(): Promise<void> };

/** Answers GET /health with 200 while `check` passes, 503 otherwise. Never published outside the container. */
export async function startHealthServer(
  port: number,
  check: () => Promise<void>,
  log: Log,
): Promise<HealthServer> {
  const server: Server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    check().then(
      () => res.writeHead(200).end("ok"),
      (error: unknown) => {
        log("warn", "Health check failed", { error: describeError(error) });
        res.writeHead(503).end("unavailable");
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
