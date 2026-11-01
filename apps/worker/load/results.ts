import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LevelResult, LevelSample } from "./level.js";

export type LevelSummary = {
  runs: number;
  stopReason: LevelResult["stopReason"];
  durationS: number;
  statuses: Record<string, number>;
  runDurationS: LevelResult["runDurationS"];
  peakActive: number;
  worker: {
    heapPeakMb: number;
    heapLimitMb: number;
    rssPeakMb: number;
    cpuAvgPercent: number;
    cpuPeakPercent: number;
    loopDelayP99PeakMs: number;
    loopDelayMaxMs: number;
    gcPauseShare: number;
    gcMaxPauseMs: number;
    poolWaitingPeak: number;
  };
  fakeCpuPeakPercent: number;
  events: LevelResult["events"] & { perSecondPeak: number };
  unpublished: number;
  doneLost: number;
  warnings: Record<string, number>;
};

const peak = (values: number[]) => (values.length ? Math.max(...values) : 0);
const average = (values: number[]) =>
  values.length
    ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
    : 0;

export function summarize(result: LevelResult): LevelSummary {
  const workers = result.samples.flatMap((s) => (s.worker ? [s.worker] : []));
  const gcPauseMs = workers.reduce((sum, w) => sum + w.gc.pauseMs, 0);
  return {
    runs: result.runs,
    stopReason: result.stopReason,
    durationS: result.durationS,
    statuses: result.statuses,
    runDurationS: result.runDurationS,
    peakActive: peak(result.samples.map((s) => s.active)),
    worker: {
      heapPeakMb: peak(workers.map((w) => w.heapUsedMb)),
      heapLimitMb: workers.at(-1)?.heapLimitMb ?? 0,
      rssPeakMb: peak(workers.map((w) => w.rssMb)),
      cpuAvgPercent: average(workers.map((w) => w.cpuPercent)),
      cpuPeakPercent: peak(workers.map((w) => w.cpuPercent)),
      loopDelayP99PeakMs: peak(workers.map((w) => w.loopDelayMs.p99)),
      loopDelayMaxMs: peak(workers.map((w) => w.loopDelayMs.max)),
      // Samples are a second apart, so the pause time adds up to a share of the time sampled.
      gcPauseShare: workers.length
        ? Math.round((gcPauseMs / (workers.length * 1000)) * 1000) / 10
        : 0,
      gcMaxPauseMs: peak(workers.map((w) => w.gc.maxPauseMs)),
      poolWaitingPeak: peak(workers.map((w) => w.pool.waiting)),
    },
    fakeCpuPeakPercent: peak(
      result.samples.flatMap((s) => (s.fake ? [s.fake.cpuPercent] : [])),
    ),
    events: {
      ...result.events,
      perSecondPeak: peak(result.samples.map((s) => s.eventsPerSecond)),
    },
    unpublished: result.unpublished,
    doneLost: result.doneLost,
    warnings: result.warnings,
  };
}

const ROWS: [string, (s: LevelSummary) => string | number][] = [
  ["Stopped", (s) => s.stopReason],
  ["Took", (s) => `${s.durationS} s`],
  [
    "Outcomes",
    (s) =>
      Object.entries(s.statuses)
        .map(([k, v]) => `${k} ${v}`)
        .join(", "),
  ],
  [
    "Run time p50 / p99",
    (s) => `${s.runDurationS.p50} / ${s.runDurationS.p99} s`,
  ],
  ["Active at peak", (s) => s.peakActive],
  [
    "Heap peak / limit",
    (s) => `${s.worker.heapPeakMb} / ${s.worker.heapLimitMb} MB`,
  ],
  ["RSS peak", (s) => `${s.worker.rssPeakMb} MB`],
  [
    "CPU avg / peak (% of a core)",
    (s) => `${s.worker.cpuAvgPercent} / ${s.worker.cpuPeakPercent}`,
  ],
  [
    "Event-loop delay p99 peak / max",
    (s) => `${s.worker.loopDelayP99PeakMs} / ${s.worker.loopDelayMaxMs} ms`,
  ],
  [
    "GC pause share / longest",
    (s) => `${s.worker.gcPauseShare}% / ${s.worker.gcMaxPauseMs} ms`,
  ],
  ["Pool waiting peak", (s) => s.worker.poolWaitingPeak],
  [
    "Events / peak per second",
    (s) => `${s.events.total} / ${s.events.perSecondPeak}`,
  ],
  [
    "Event lag p50 / p99 / max",
    (s) =>
      `${s.events.lagMs.p50} / ${s.events.lagMs.p99} / ${s.events.lagMs.max} ms`,
  ],
  ["Stored but not published", (s) => s.unpublished],
  ["Ended, `done` lost", (s) => s.doneLost],
  [
    "Worker warnings",
    (s) =>
      Object.entries(s.warnings)
        .map(([k, v]) => `${k} (${v})`)
        .join("; ") || "none",
  ],
  ["Fake OpenAI CPU peak", (s) => `${s.fakeCpuPeakPercent}%`],
];

export function summaryTable(summaries: LevelSummary[]) {
  const header = `| | ${summaries.map((s) => `${s.runs} runs`).join(" | ")} |`;
  const divider = `|---|${summaries.map(() => "---").join("|")}|`;
  const rows = ROWS.map(
    ([label, value]) => `| ${label} | ${summaries.map(value).join(" | ")} |`,
  );
  return [header, divider, ...rows].join("\n");
}

export function createResults(dir: string) {
  mkdirSync(dir, { recursive: true });
  const samples = path.join(dir, "samples.jsonl");
  return {
    dir,
    sample: (runs: number, sample: LevelSample) =>
      appendFileSync(
        samples,
        `${JSON.stringify({ level: runs, ...sample })}\n`,
      ),
    write(settings: unknown, summaries: LevelSummary[]) {
      writeFileSync(
        path.join(dir, "summary.json"),
        JSON.stringify({ settings, levels: summaries }, null, 2),
      );
      writeFileSync(
        path.join(dir, "summary.md"),
        `# Load test\n\n\`\`\`json\n${JSON.stringify(settings, null, 2)}\n\`\`\`\n\n${summaryTable(summaries)}\n`,
      );
    },
  };
}
