import type { Sandbox, SandboxLabels } from "@hobai/sandbox";

/** The signal stops a wait for sandbox room. */
export type SandboxFactory = (
  labels: SandboxLabels,
  signal?: AbortSignal,
) => Promise<Sandbox>;

export type SandboxConnector = (id: string) => Promise<Sandbox | null>;
