import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import v8 from "node:v8";
import type { ProcessSample, WorkerSample } from "./messages.js";

const MB = 1024 * 1024;
const round = (value: number) => Math.round(value * 10) / 10;

/** CPU time used since the last call, as a share of one core (100 = one core fully busy). */
export function cpuMeter() {
  let last = process.cpuUsage();
  let at = performance.now();
  return () => {
    const now = performance.now();
    const used = process.cpuUsage(last);
    last = process.cpuUsage();
    const elapsedUs = (now - at) * 1000;
    at = now;
    return elapsedUs > 0
      ? round(((used.user + used.system) / elapsedUs) * 100)
      : 0;
  };
}

export function processSampler(): () => ProcessSample {
  const cpu = cpuMeter();
  return () => ({
    cpuPercent: cpu(),
    rssMb: round(process.memoryUsage.rss() / MB),
  });
}

/** Samples the worker process every interval: memory, CPU, event-loop delay, GC and the database pool. */
export function startWorkerProbe(options: {
  intervalMs: number;
  poolStats: () => WorkerSample["pool"];
  send: (sample: WorkerSample) => void;
}) {
  const base = processSampler();
  // Delays are measured from timers this many ms apart, so they can't read lower than it.
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  const gc = { count: 0, pauseMs: 0, maxPauseMs: 0 };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gc.count += 1;
      gc.pauseMs += entry.duration;
      gc.maxPauseMs = Math.max(gc.maxPauseMs, entry.duration);
    }
  });
  observer.observe({ entryTypes: ["gc"] });

  const timer = setInterval(() => {
    const heap = v8.getHeapStatistics();
    options.send({
      ...base(),
      heapUsedMb: round(heap.used_heap_size / MB),
      heapLimitMb: round(heap.heap_size_limit / MB),
      // The histogram is in nanoseconds.
      loopDelayMs: {
        p50: round(loop.percentile(50) / 1e6),
        p99: round(loop.percentile(99) / 1e6),
        max: round(loop.max / 1e6),
      },
      gc: {
        count: gc.count,
        pauseMs: round(gc.pauseMs),
        maxPauseMs: round(gc.maxPauseMs),
      },
      pool: options.poolStats(),
    });
    loop.reset();
    Object.assign(gc, { count: 0, pauseMs: 0, maxPauseMs: 0 });
  }, options.intervalMs);

  return () => {
    clearInterval(timer);
    loop.disable();
    observer.disconnect();
  };
}
