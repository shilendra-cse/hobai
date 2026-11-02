import { describe, expect, it } from "vitest";
import { describeError } from "./describe-error.js";

describe("describeError", () => {
  it("adds the causes a wrapped error hides", () => {
    const pg = new Error("timeout exceeded when trying to connect");
    expect(
      describeError(new Error("Failed query: update runs", { cause: pg })),
    ).toBe(
      "Failed query: update runs; caused by: timeout exceeded when trying to connect",
    );
  });

  it("describes anything thrown", () => {
    expect(describeError("boom")).toBe("boom");
    expect(describeError(new Error("alone"))).toBe("alone");
  });
});
