import { z } from "zod";

// What the worker and fake OpenAI processes send the driver over IPC.

export const processSample = z.object({
  cpuPercent: z.number(),
  rssMb: z.number(),
});

export const workerSample = processSample.extend({
  heapUsedMb: z.number(),
  heapLimitMb: z.number(),
  loopDelayMs: z.object({ p50: z.number(), p99: z.number(), max: z.number() }),
  gc: z.object({
    count: z.number(),
    pauseMs: z.number(),
    maxPauseMs: z.number(),
  }),
  pool: z.object({ total: z.number(), idle: z.number(), waiting: z.number() }),
});

export type ProcessSample = z.infer<typeof processSample>;
export type WorkerSample = z.infer<typeof workerSample>;

export const childMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), url: z.string().optional() }),
  z.object({ type: z.literal("worker-sample"), sample: workerSample }),
  z.object({ type: z.literal("fake-sample"), sample: processSample }),
]);

export type ChildMessage = z.infer<typeof childMessage>;
