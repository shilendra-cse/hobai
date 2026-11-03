import type { AgentResult } from "@hobai/agent";
import type { FinalRunStatus, SetupResult } from "@hobai/shared";
import type { Diff } from "../stages/changes/index.js";
import type { ChangeSet } from "../stages/deliver/index.js";
import type { VerifyResult } from "../stages/verify/index.js";

export type RunStageName =
  "sandbox" | "checkout" | "setup" | "agent" | "verify" | "deliver";

export type Delivery = { branchName: string; sha: string };

export type DeliverableRun = {
  agent: AgentResult;
  verify: VerifyResult;
  diff: Diff;
};

/** Turns the change set into a commit outside the sandbox, which never sees a write token. */
export type Deliver = (
  changes: ChangeSet,
  run: DeliverableRun,
) => Promise<Delivery>;

export type RunResult = {
  status: FinalRunStatus;
  failedStage?: RunStageName;
  error?: string;
  /** The run reached its time limit (RUN_TIME_LIMIT_MS) and was stopped. */
  timeLimitReached?: boolean;
  /** The provider had no room for a sandbox, even after waiting. */
  sandboxBusy?: boolean;
  sandboxId?: string;
  checkout?: { description: string; files: number | null };
  setup?: SetupResult;
  agent?: AgentResult;
  verify?: VerifyResult;
  diff?: Diff;
  delivery?: Delivery;
  durationMs: number;
};
