import { describe, expect, it } from "vitest";
import { runFailure } from "./run-record.js";

describe("runFailure", () => {
  it("names a run the provider had no sandbox room for", () => {
    expect(
      runFailure({
        status: "failed",
        failedStage: "sandbox",
        error: "All sandboxes were busy for 10 minutes; try again shortly.",
        sandboxBusy: true,
        durationMs: 600_000,
      }),
    ).toEqual({
      code: "sandbox_busy",
      message: "All sandboxes were busy for 10 minutes; try again shortly.",
    });
  });

  it("names any other failure by its stage", () => {
    expect(
      runFailure({
        status: "failed",
        failedStage: "sandbox",
        error: "bad template",
        durationMs: 1,
      }),
    ).toEqual({ code: "sandbox_failed", message: "bad template" });
  });
});
